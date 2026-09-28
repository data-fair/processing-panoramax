import type { AxiosInstance } from 'axios'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import type { SourcePhotoLine } from './diff.ts'

// référents géographiques reconnus dans le schéma d'un jeu de données data-fair
export const DIGITAL_DOCUMENT_REF = 'http://schema.org/DigitalDocument'
export const GEOMETRY_REF = 'https://purl.org/geojson/vocab#geometry'
export const LATITUDE_REF = 'http://schema.org/latitude'
export const LONGITUDE_REF = 'http://schema.org/longitude'
export const WGS84_LAT_REF = 'http://www.w3.org/2003/01/geo/wgs84_pos#lat'
export const WGS84_LON_REF = 'http://www.w3.org/2003/01/geo/wgs84_pos#long'
export const LAT_LON_REF = 'http://www.w3.org/2003/01/geo/wgs84_pos#lat_long'

export interface SourceFields {
  attachment: string
  geometry?: string
  lat?: string
  lon?: string
  latLon?: string
  date?: string
}

export const getDataset = async (axios: AxiosInstance, id: string): Promise<any> => {
  try {
    return (await axios.get(`api/v1/datasets/${id}`)).data
  } catch (err: any) {
    if (err.response?.status === 404 || err.status === 404) throw new Error(`le jeu de données ${id} n'existe pas`)
    throw err
  }
}

/** Détecte les colonnes utiles du jeu source à partir de son schéma. */
export const findSourceFields = (dataset: any, config: { photoField?: string, dateField?: string }): SourceFields => {
  const schema: any[] = dataset.schema ?? []
  const attachment: string | undefined = config.photoField ||
    schema.find(f => f['x-refersTo'] === DIGITAL_DOCUMENT_REF && !f['x-calculated'])?.key
  if (!attachment) throw new Error('aucune colonne pièce jointe (concept DigitalDocument) trouvée dans le schéma du jeu source')
  if (!schema.some(f => f.key === attachment)) throw new Error(`la colonne photo "${attachment}" n'existe pas dans le schéma du jeu source`)

  const geometry = schema.find(f => f['x-refersTo'] === GEOMETRY_REF && !f['x-calculated'])?.key
  const lat = schema.find(f => (f['x-refersTo'] === LATITUDE_REF || f['x-refersTo'] === WGS84_LAT_REF) && !f['x-calculated'])?.key
  const lon = schema.find(f => (f['x-refersTo'] === LONGITUDE_REF || f['x-refersTo'] === WGS84_LON_REF) && !f['x-calculated'])?.key
  const latLon = schema.find(f => (f['x-refersTo'] === LAT_LON_REF || f['x-concept']?.id === 'latLon') && !f['x-calculated'])?.key
  if (!geometry && !(lat && lon) && !latLon) {
    throw new Error('aucune colonne géographique (géométrie GeoJSON ou latitude/longitude) trouvée dans le schéma du jeu source')
  }

  return { attachment, geometry, lat, lon, latLon, date: config.dateField }
}

/** Lit toutes les lignes du jeu source, page après page. */
export const readSourceLines = async (axios: AxiosInstance, datasetId: string, fields: SourceFields): Promise<SourcePhotoLine[]> => {
  const select = ['_id', fields.attachment, fields.geometry, fields.geometry ? '_geoshape' : undefined, fields.lat, fields.lon, fields.latLon, fields.date]
    .filter((key): key is string => !!key)
  let url: string | undefined = `api/v1/datasets/${datasetId}/lines?size=1000&select=${encodeURIComponent(select.join(','))}`

  const lines: SourcePhotoLine[] = []
  while (url) {
    const res: any = await axios.get(url)
    for (const row of res.data?.results ?? []) lines.push(toSourceLine(row, fields))
    url = res.data?.next
  }
  return lines
}

const toSourceLine = (row: any, fields: SourceFields): SourcePhotoLine => {
  const position = extractPosition(row, fields)
  return {
    lineId: String(row._id),
    photoRef: typeof row[fields.attachment] === 'string' && row[fields.attachment].trim() ? row[fields.attachment] : null,
    ...position,
    capturedAt: extractDate(fields.date ? row[fields.date] : undefined)
  }
}

const extractPosition = (row: any, fields: SourceFields): { latitude: number | null, longitude: number | null } => {
  const position =
    (fields.geometry ? pointFromGeometry(row[fields.geometry]) : null) ??
    pointFromGeometry(row._geoshape) ??
    pointFromLatLon(row, fields) ??
    pointFromLatLonString(row, fields)
  return position ?? { latitude: null, longitude: null }
}

const pointFromGeometry = (value: unknown): { latitude: number, longitude: number } | null => {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  const geometry = value as { type?: string, coordinates?: unknown } | null
  if (geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates)) return null
  const [lon, lat] = geometry.coordinates
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  return { latitude: Number(lat), longitude: Number(lon) }
}

const pointFromLatLon = (row: any, fields: SourceFields): { latitude: number, longitude: number } | null => {
  if (!fields.lat || !fields.lon) return null
  const lat = Number(row[fields.lat])
  const lon = Number(row[fields.lon])
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return { latitude: lat, longitude: lon }
}

const pointFromLatLonString = (row: any, fields: SourceFields): { latitude: number, longitude: number } | null => {
  if (!fields.latLon || typeof row[fields.latLon] !== 'string') return null
  const [lat, lon] = row[fields.latLon].split(/[,;]/).map((value: string) => Number(value.trim()))
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return { latitude: lat, longitude: lon }
}

const extractDate = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined
  const date = new Date(value as string)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

export const attachmentUrl = (datasetId: string, photoRef: string): string =>
  /^https?:\/\//.test(photoRef)
    ? photoRef
    : `api/v1/datasets/${datasetId}/attachments/${photoRef.split('/').map(encodeURIComponent).join('/')}`

export const downloadAttachment = async (axios: AxiosInstance, datasetId: string, photoRef: string, destPath: string): Promise<void> => {
  const res = await axios.get(attachmentUrl(datasetId, photoRef), { responseType: 'stream' })
  await pipeline(res.data, createWriteStream(destPath))
}
