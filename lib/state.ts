import type { AxiosInstance } from 'axios'
import type { MappingRow } from './diff.ts'

export const COMPANION_EXTRAS_KEY = 'panoramaxSync'

const BULK_CHUNK_SIZE = 1000

/** Schéma du jeu de suivi : une ligne par photo synchronisée. */
export const companionSchema = [
  { key: 'lineId', type: 'string', title: 'Ligne source' },
  { key: 'photoRef', type: 'string', title: 'Référence de la photo' },
  { key: 'latitude', type: 'number', title: 'Latitude' },
  { key: 'longitude', type: 'number', title: 'Longitude' },
  { key: 'capturedAt', type: 'string', title: 'Date de prise de vue' },
  { key: 'status', type: 'string', title: 'Statut' },
  { key: 'panoramaItemId', type: 'string', title: 'Identifiant Panoramax' },
  { key: 'panoramaCollectionId', type: 'string', title: 'Collection Panoramax' },
  { key: 'error', type: 'string', title: 'Erreur' },
  { key: 'syncedAt', type: 'string', title: 'Synchronisé le' }
]

export const createCompanion = async (
  axios: AxiosInstance,
  { title, sourceDatasetId, processingId }: { title: string, sourceDatasetId: string, processingId: string }
): Promise<any> => {
  const res = await axios.post('api/v1/datasets', {
    title,
    isRest: true,
    schema: companionSchema,
    extras: {
      [COMPANION_EXTRAS_KEY]: { sourceDatasetId, processingId }
    }
  })
  return res.data
}

export const getCompanion = async (axios: AxiosInstance, id: string): Promise<any> => {
  try {
    return (await axios.get(`api/v1/datasets/${id}`)).data
  } catch (err: any) {
    if (err.response?.status === 404 || err.status === 404) throw new Error(`le jeu de suivi ${id} n'existe pas`)
    throw err
  }
}

/** Lit toutes les lignes de suivi, page après page. */
export const readMapping = async (axios: AxiosInstance, companionId: string): Promise<MappingRow[]> => {
  let url: string | undefined = `api/v1/datasets/${companionId}/lines?size=1000`
  const rows: MappingRow[] = []
  while (url) {
    const res: any = await axios.get(url)
    for (const row of res.data?.results ?? []) rows.push(row as MappingRow)
    url = res.data?.next
  }
  return rows
}

export interface MappingAction {
  _action: 'create' | 'update' | 'delete'
  _id?: string
  [key: string]: unknown
}

/** Écrit les créations, mises à jour et suppressions de lignes du jeu de suivi. */
export const writeMapping = async (
  axios: AxiosInstance,
  companionId: string,
  actions: MappingAction[],
  log: { info: (msg: string, extra?: any) => Promise<void>, error: (msg: string, extra?: any) => Promise<void> }
): Promise<void> => {
  let nbErrors = 0
  const errors: string[] = []
  for (let i = 0; i < actions.length; i += BULK_CHUNK_SIZE) {
    const chunk = actions.slice(i, i + BULK_CHUNK_SIZE)
    const res = await axios.post(`api/v1/datasets/${companionId}/_bulk_lines`, chunk, { timeout: 60000, maxBodyLength: Infinity })
    nbErrors += res.data?.nbErrors ?? 0
    for (const error of res.data?.errors ?? []) errors.push(JSON.stringify(error))
  }
  await log.info(`${actions.length} ligne(s) de suivi enregistrée(s)`)
  if (nbErrors) {
    await log.error(`${nbErrors} erreur(s) d'écriture dans le jeu de suivi`, errors.join('\n'))
  }
}
