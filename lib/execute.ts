import path from 'node:path'
import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'
import { PanoramaxClient, type UploadSet } from './panoramax.ts'
import { diffLines, type MappingRow, type MappingStatus, type PatchItem, type SyncLine, type UploadItem } from './diff.ts'
import { uuidv5 } from './uuid.ts'
import { downloadAttachment, findSourceFields, getDataset, readSourceLines } from './source.ts'
import { createCompanion, getCompanion, readMapping, writeMapping, type MappingAction } from './state.ts'

const UPLOAD_SET_POLL_INTERVAL = 5000
const UPLOAD_SET_POLL_ATTEMPTS = 120

let shouldBeStopped = false

export const stop = async (): Promise<void> => {
  shouldBeStopped = true
}

export const isStopped = (): boolean => shouldBeStopped

interface SyncResult {
  status: MappingStatus
  itemId?: string
  collectionId?: string
  error?: string
}

const errorMessage = (err: any): string => err?.response?.data ? `${err.message} (${JSON.stringify(err.response.data)})` : (err?.message ?? String(err))

const pictureIdFor = (sourceDatasetId: string, line: SyncLine): string =>
  uuidv5(`${sourceDatasetId}:${line.lineId}:${line.photoRef}`)

export const run = async (context: ProcessingContext<ProcessingConfig>): Promise<void> => {
  const { processingConfig, secrets, axios, log, processingId } = context
  shouldBeStopped = false
  // ponytail: pas de verrou entre exécutions concurrentes ; les identifiants Panoramax
  // déterministes évitent les doublons, ajouter un verrou si la cadence augmente

  const panoramaxUrl = processingConfig.panoramaxUrl?.trim()
  if (!panoramaxUrl) throw new Error("URL de l'instance Panoramax manquante, enregistrez la configuration avant d'exécuter le traitement.")
  const token = secrets?.panoramaxToken ?? processingConfig.panoramaxToken
  if (!token || token === '********') throw new Error("Jeton d'accès Panoramax manquant, enregistrez la configuration avant d'exécuter le traitement.")
  const sourceDatasetId = processingConfig.sourceDataset?.id
  if (!sourceDatasetId) throw new Error('Jeu de données source manquant, enregistrez la configuration avant d\'exécuter le traitement.')

  const client = new PanoramaxClient(axios, panoramaxUrl, token)

  await log.step('Vérification du jeu de données source')
  const sourceDataset = await getDataset(axios, sourceDatasetId)
  if (!sourceDataset.isRest) throw new Error(`le jeu de données source "${sourceDataset.title}" n'est pas éditable (REST)`)
  const fields = findSourceFields(sourceDataset, processingConfig)
  await log.info(`champ photo "${fields.attachment}"${fields.date ? `, date de prise de vue "${fields.date}"` : ''}`)

  await log.step('Préparation du jeu de suivi')
  const companion = await ensureCompanion(context, sourceDatasetId, processingId)

  await log.step('Lecture des lignes source')
  const sourceLines = await readSourceLines(axios, sourceDatasetId, fields)
  const mapping = await readMapping(axios, companion.id)
  const diff = diffLines(sourceLines, mapping)
  await log.info(`${sourceLines.length} ligne(s) source, ${diff.toUpload.length} à envoyer, ${diff.toPatch.length} à mettre à jour, ${diff.toDelete.length} à supprimer, ${diff.unchanged} inchangée(s)`)
  if (diff.skipped) await log.warning(`${diff.skipped} photo(s) ignorée(s) faute de position exploitable`)

  if (isStopped()) return await stopped(log)

  const results = new Map<string, SyncResult>()
  const previousByLine = new Map<string, MappingRow>()
  for (const item of diff.toUpload) {
    if (item.previous) previousByLine.set(item.line.lineId, item.previous)
  }
  for (const item of diff.toPatch) {
    previousByLine.set(item.line.lineId, item.mapping)
  }

  if (diff.toUpload.length) {
    await uploadPhotos(context, client, diff.toUpload, results)
  }

  if (isStopped()) return await stopped(log)

  if (diff.toPatch.length) {
    await log.step(`Mise à jour de la position de ${diff.toPatch.length} photo(s)`)
    await patchPhotos(context, client, diff.toPatch, results)
  }

  if (isStopped()) return await stopped(log)

  const deletedIds: string[] = []
  if (diff.toDelete.length) {
    await log.step(`Suppression de ${diff.toDelete.length} photo(s)`)
    await deletePhotos(context, client, diff.toDelete, deletedIds)
  }

  await persistMapping(axios, companion.id, diff.toUpload, diff.toPatch, previousByLine, results, deletedIds, log)

  const ready = [...results.values()].filter(result => result.status === 'ready').length
  const failed = results.size - ready
  await log.step('Rapport final')
  await log.info(`${ready} photo(s) synchronisée(s), ${failed} en erreur, ${deletedIds.length} supprimée(s)`)
  if (failed) await log.warning(`${failed} photo(s) seront retentées à la prochaine exécution`)
}

const stopped = async (log: ProcessingContext<ProcessingConfig>['log']): Promise<void> => {
  await log.warning('Traitement interrompu, les opérations en attente seront reprises à la prochaine exécution')
}

const ensureCompanion = async (context: ProcessingContext<ProcessingConfig>, sourceDatasetId: string, processingId: string): Promise<any> => {
  const { processingConfig, axios, log, patchConfig } = context
  if (processingConfig.datasetMode === 'update') {
    const dataset = await getCompanion(axios, processingConfig.dataset.id)
    await log.info(`jeu de suivi existant "${dataset.title}" (${dataset.id})`)
    return dataset
  }
  const dataset = await createCompanion(axios, {
    title: processingConfig.datasetTitle || 'Suivi Panoramax',
    sourceDatasetId,
    processingId
  })
  await log.info(`jeu de suivi créé "${dataset.title}" (${dataset.id})`)
  await patchConfig({ datasetMode: 'update', dataset: { id: dataset.id, title: dataset.title } })
  return dataset
}

const uploadPhotos = async (
  context: ProcessingContext<ProcessingConfig>,
  client: PanoramaxClient,
  items: UploadItem[],
  results: Map<string, SyncResult>
): Promise<void> => {
  const { processingConfig, axios, log, tmpDir, processingId } = context
  const sourceDatasetId = processingConfig.sourceDataset?.id as string

  const uploadSetId = await client.createUploadSet({
    title: `Data Fair - ${processingConfig.sourceDataset?.title ?? sourceDatasetId} - ${new Date().toISOString().slice(0, 10)}`,
    estimated_nb_files: items.length,
    no_deduplication: true,
    visibility: processingConfig.visibility ?? 'anyone',
    metadata: { dataFairDatasetId: sourceDatasetId, processingId }
  })
  await log.info(`lot d'envoi ${uploadSetId} créé pour ${items.length} photo(s)`)

  let complete = false
  try {
    let sent = 0
    for (const item of items) {
      if (isStopped()) return
      const { line } = item
      try {
        const pictureId = pictureIdFor(sourceDatasetId, line)
        const filePath = path.join(tmpDir, `${pictureId}.jpg`)
        await downloadAttachment(axios, sourceDatasetId, line.photoRef, filePath)
        await client.addFile(uploadSetId, {
          path: filePath,
          filename: `${line.lineId}.jpg`,
          pictureId,
          latitude: line.latitude,
          longitude: line.longitude,
          capturedAt: line.capturedAt
        })
        sent++
        await log.progress('Photos téléversées', sent, items.length)
      } catch (err) {
        results.set(line.lineId, { status: 'error', error: errorMessage(err) })
        await log.error(`échec de l'envoi de la photo de la ligne ${line.lineId}`, errorMessage(err))
      }
    }
    await client.completeUploadSet(uploadSetId)
    complete = true
  } finally {
    if (!complete) {
      // lot non terminé : les photos ne sont pas publiées, on le supprime
      await client.deleteUploadSet(uploadSetId).catch((err) => log.warning(`échec de la suppression du lot ${uploadSetId}`, errorMessage(err)))
    }
  }

  const uploadSet = await waitForUploadSet(context, client, uploadSetId)
  if (!uploadSet?.ready) await log.warning(`le lot ${uploadSetId} n'est pas prêt, les photos seront reprises à la prochaine exécution`)

  const files = await client.getUploadSetFiles(uploadSetId)
  const filesByPictureId = new Map(files.filter(file => file.picture_id).map(file => [file.picture_id as string, file]))
  const itemsByPictureId = await client.listUploadSetItems(uploadSet)

  for (const item of items) {
    const { line, previous } = item
    if (results.get(line.lineId)?.status === 'error') continue
    const pictureId = pictureIdFor(sourceDatasetId, line)
    const rejection = filesByPictureId.get(pictureId)?.rejected
    let collectionId = itemsByPictureId.get(pictureId)
    if (!collectionId) {
      // reprise après interruption : l'identifiant déterministe peut déjà exister
      const existing = await client.getPicture(pictureId).catch(() => undefined)
      collectionId = existing?.collection
    }
    if (collectionId) {
      results.set(line.lineId, { status: 'ready', itemId: pictureId, collectionId })
      if (previous?.panoramaItemId && previous.panoramaItemId !== pictureId && previous.panoramaCollectionId) {
        await client.deletePicture(previous.panoramaCollectionId, previous.panoramaItemId)
          .catch((err) => log.warning(`ancienne photo ${previous.panoramaItemId} non supprimée`, errorMessage(err)))
      }
    } else {
      const error = rejection?.message ?? rejection?.reason ?? (uploadSet?.ready ? 'photo introuvable après traitement' : 'traitement encore en cours côté Panoramax')
      results.set(line.lineId, { status: 'error', error })
      await log.error(`échec de l'envoi de la photo de la ligne ${line.lineId}`, error)
    }
  }
}

const waitForUploadSet = async (context: ProcessingContext<ProcessingConfig>, client: PanoramaxClient, uploadSetId: string): Promise<UploadSet | undefined> => {
  const { log } = context
  let uploadSet = await client.getUploadSet(uploadSetId)
  for (let attempt = 0; attempt < UPLOAD_SET_POLL_ATTEMPTS; attempt++) {
    if (uploadSet.ready) return uploadSet
    if (isStopped()) return undefined
    if (attempt === 0) await log.info('traitement des photos en cours côté Panoramax...')
    await new Promise(resolve => setTimeout(resolve, UPLOAD_SET_POLL_INTERVAL))
    uploadSet = await client.getUploadSet(uploadSetId)
  }
  return uploadSet
}

const patchPhotos = async (
  context: ProcessingContext<ProcessingConfig>,
  client: PanoramaxClient,
  items: PatchItem[],
  results: Map<string, SyncResult>
): Promise<void> => {
  const { log } = context
  let patched = 0
  for (const { line, mapping } of items) {
    if (isStopped()) return
    try {
      await client.patchPicture(mapping.panoramaItemId as string, {
        latitude: line.latitude,
        longitude: line.longitude,
        ...(line.capturedAt ? { capture_time: line.capturedAt } : {})
      })
      results.set(line.lineId, { status: 'ready', itemId: mapping.panoramaItemId, collectionId: mapping.panoramaCollectionId })
      patched++
      await log.progress('Photos mises à jour', patched, items.length)
    } catch (err) {
      await log.error(`échec de la mise à jour de la photo ${mapping.panoramaItemId}`, errorMessage(err))
    }
  }
}

const deletePhotos = async (
  context: ProcessingContext<ProcessingConfig>,
  client: PanoramaxClient,
  items: MappingRow[],
  deletedIds: string[]
): Promise<void> => {
  const { log } = context
  let deleted = 0
  for (const row of items) {
    if (isStopped()) return
    try {
      if (row.panoramaItemId) {
        let collectionId = row.panoramaCollectionId
        if (!collectionId) {
          const picture = await client.getPicture(row.panoramaItemId).catch(() => undefined)
          collectionId = picture?.collection
        }
        if (collectionId) {
          await client.deletePicture(collectionId, row.panoramaItemId)
        } else {
          await log.warning(`photo ${row.panoramaItemId} introuvable côté Panoramax, ligne de suivi supprimée`)
        }
      }
      if (row._id) deletedIds.push(row._id)
      deleted++
      await log.progress('Photos supprimées', deleted, items.length)
    } catch (err) {
      await log.error(`échec de la suppression de la photo ${row.panoramaItemId}`, errorMessage(err))
    }
  }
}

const persistMapping = async (
  axios: ProcessingContext<ProcessingConfig>['axios'],
  companionId: string,
  toUpload: UploadItem[],
  toPatch: PatchItem[],
  previousByLine: Map<string, MappingRow>,
  results: Map<string, SyncResult>,
  deletedIds: string[],
  log: ProcessingContext<ProcessingConfig>['log']
): Promise<void> => {
  const actions: MappingAction[] = []
  const syncedAt = new Date().toISOString()

  for (const item of [...toUpload, ...toPatch]) {
    const { line } = item
    const result = results.get(line.lineId)
    if (!result) continue
    const previous = previousByLine.get(line.lineId)
    if (result.status === 'error' && previous?._id) {
      // on conserve la ligne de suivi précédente : la photo déjà en ligne reste la référence
      continue
    }
    actions.push({
      _action: previous?._id ? 'update' : 'create',
      ...(previous?._id ? { _id: previous._id } : {}),
      lineId: line.lineId,
      photoRef: line.photoRef,
      latitude: line.latitude,
      longitude: line.longitude,
      ...(line.capturedAt ? { capturedAt: line.capturedAt } : {}),
      status: result.status,
      ...(result.itemId ? { panoramaItemId: result.itemId } : {}),
      ...(result.collectionId ? { panoramaCollectionId: result.collectionId } : {}),
      ...(result.error ? { error: result.error } : {}),
      syncedAt
    })
  }
  for (const _id of deletedIds) {
    actions.push({ _action: 'delete', _id })
  }
  if (actions.length) await writeMapping(axios, companionId, actions, log)
}
