/**
 * Logique pure de comparaison entre les photos du jeu source et le jeu de suivi.
 * Aucun appel réseau ici, tout est testable.
 */

export type MappingStatus = 'ready' | 'error'

/** Une ligne du jeu de suivi (une photo synchronisée). */
export interface MappingRow {
  _id?: string
  lineId: string
  photoRef?: string
  latitude?: number
  longitude?: number
  capturedAt?: string
  status?: MappingStatus
  panoramaItemId?: string
  panoramaCollectionId?: string
  error?: string
  syncedAt?: string
}

/** Une ligne du jeu source portant éventuellement une photo. */
export interface SourcePhotoLine {
  lineId: string
  photoRef: string | null
  latitude: number | null
  longitude: number | null
  capturedAt?: string
}

/** Une ligne source exploitable : photo présente et position connue. */
export interface SyncLine extends SourcePhotoLine {
  photoRef: string
  latitude: number
  longitude: number
}

export interface UploadItem {
  line: SyncLine
  previous?: MappingRow
}

export interface PatchItem {
  line: SyncLine
  mapping: MappingRow
}

export interface SyncDiff {
  toUpload: UploadItem[]
  toPatch: PatchItem[]
  toDelete: MappingRow[]
  unchanged: number
  skipped: number
}

const syncable = (line: SourcePhotoLine): line is SyncLine =>
  !!line.photoRef && line.latitude !== null && line.longitude !== null

const positionChanged = (row: MappingRow, line: SyncLine): boolean =>
  typeof row.latitude !== 'number' || typeof row.longitude !== 'number' ||
  Math.abs(row.latitude - line.latitude) > 1e-9 ||
  Math.abs(row.longitude - line.longitude) > 1e-9

/**
 * Compare l'état voulu (lignes source) à l'état connu (jeu de suivi).
 * - `toUpload` : photo nouvelle, remplacée, ou dont la synchronisation précédente a échoué
 * - `toPatch` : même photo, position ou date modifiée
 * - `toDelete` : ligne source disparue ou photo retirée
 * - `skipped` : photo présente mais position inexploitable (on ne touche à rien)
 */
export const diffLines = (sourceLines: SourcePhotoLine[], mapping: MappingRow[]): SyncDiff => {
  const sourceById = new Map(sourceLines.map(line => [line.lineId, line]))
  const mappingById = new Map(mapping.map(row => [row.lineId, row]))
  const toUpload: UploadItem[] = []
  const toPatch: PatchItem[] = []
  const toDelete: MappingRow[] = []
  let unchanged = 0
  let skipped = 0

  for (const row of mapping) {
    const line = sourceById.get(row.lineId)
    if (!line || !line.photoRef) toDelete.push(row)
  }

  for (const line of sourceLines) {
    if (!line.photoRef) continue
    if (!syncable(line)) {
      skipped++
      continue
    }
    const row = mappingById.get(line.lineId)
    if (!row || row.photoRef !== line.photoRef || row.status !== 'ready' || !row.panoramaItemId) {
      toUpload.push({ line, previous: row })
      continue
    }
    if (positionChanged(row, line) || (row.capturedAt ?? null) !== (line.capturedAt ?? null)) {
      toPatch.push({ line, mapping: row })
    } else {
      unchanged++
    }
  }

  return { toUpload, toPatch, toDelete, unchanged, skipped }
}
