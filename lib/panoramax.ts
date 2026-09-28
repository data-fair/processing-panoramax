import type { AxiosInstance } from 'axios'
import FormData from 'form-data'
import { createReadStream } from 'node:fs'

const USER_AGENT = 'data-fair-processing-panoramax'
const REQUEST_TIMEOUT = 30000
const UPLOAD_TIMEOUT = 120000

export interface UploadSetFile {
  file_name?: string
  picture_id?: string
  rejected?: { reason?: string, severity?: string, message?: string } | null
}

export interface PanoramaxPicture {
  id: string
  collection?: string
}

export interface UploadSet {
  ready?: boolean
  associated_collections?: { id: string }[]
}

const getFormLength = (form: FormData): Promise<number> => new Promise((resolve, reject) => {
  form.getLength((err, length) => {
    if (err) reject(err)
    else resolve(length)
  })
})

/**
 * Client minimal de l'API Panoramax (téléversement par lots, collections, suppression).
 */
export class PanoramaxClient {
  private axios: AxiosInstance
  private baseUrl: string
  private token: string

  constructor (axios: AxiosInstance, baseUrl: string, token: string) {
    this.axios = axios
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.token = token
  }

  private options (extra: any = {}): any {
    return {
      timeout: REQUEST_TIMEOUT,
      ...extra,
      headers: { Authorization: `Bearer ${this.token}`, 'User-Agent': USER_AGENT, ...(extra.headers ?? {}) }
    }
  }

  async createUploadSet (body: Record<string, unknown>): Promise<string> {
    const res = await this.axios.post(`${this.baseUrl}/api/upload_sets`, body, this.options({ headers: { 'Content-Type': 'application/json' } }))
    const id = res.data?.id
    if (!id) throw new Error('réponse inattendue de Panoramax à la création du lot de photos')
    return id
  }

  async deleteUploadSet (id: string): Promise<void> {
    await this.axios.delete(`${this.baseUrl}/api/upload_sets/${id}`, this.options())
  }

  async addFile (uploadSetId: string, file: {
    path: string
    filename: string
    pictureId: string
    latitude: number
    longitude: number
    capturedAt?: string
  }): Promise<void> {
    const form = new FormData()
    form.append('file', createReadStream(file.path), { filename: file.filename, contentType: 'image/jpeg' })
    form.append('picture_id', file.pictureId)
    form.append('override_latitude', String(file.latitude))
    form.append('override_longitude', String(file.longitude))
    if (file.capturedAt) form.append('override_capture_time', file.capturedAt)
    const contentLength = await getFormLength(form)
    await this.axios.post(`${this.baseUrl}/api/upload_sets/${uploadSetId}/files`, form, this.options({
      headers: { ...form.getHeaders(), 'content-length': contentLength },
      timeout: UPLOAD_TIMEOUT,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    }))
  }

  async completeUploadSet (id: string): Promise<void> {
    await this.axios.post(`${this.baseUrl}/api/upload_sets/${id}/complete`, undefined, this.options())
  }

  async getUploadSet (id: string): Promise<UploadSet> {
    const res = await this.axios.get(`${this.baseUrl}/api/upload_sets/${id}`, this.options())
    return res.data ?? {}
  }

  async getUploadSetFiles (id: string): Promise<UploadSetFile[]> {
    const res = await this.axios.get(`${this.baseUrl}/api/upload_sets/${id}/files`, this.options())
    return res.data?.files ?? []
  }

  /** Associe chaque identifiant de photo téléversée à sa collection Panoramax. */
  async listUploadSetItems (uploadSet: UploadSet | undefined): Promise<Map<string, string>> {
    const items = new Map<string, string>()
    for (const collection of uploadSet?.associated_collections ?? []) {
      for (const item of await this.listCollectionItems(collection.id)) {
        if (item.id) items.set(item.id, collection.id)
      }
    }
    return items
  }

  async listCollectionItems (collectionId: string): Promise<PanoramaxPicture[]> {
    const pictures: PanoramaxPicture[] = []
    let url: string | undefined = `${this.baseUrl}/api/collections/${collectionId}/items?limit=1000`
    while (url) {
      const res: any = await this.axios.get(url, this.options())
      for (const feature of res.data?.features ?? []) {
        pictures.push({ id: feature.id, collection: feature.collection ?? collectionId })
      }
      const next = (res.data?.links ?? []).find((link: any) => link.rel === 'next')
      url = next?.href ? new URL(next.href, `${this.baseUrl}/`).toString() : undefined
    }
    return pictures
  }

  /** Retourne la photo si elle est prête, undefined si elle est en cours de traitement ou absente. */
  async getPicture (pictureId: string): Promise<PanoramaxPicture | undefined> {
    const res = await this.axios.get(`${this.baseUrl}/api/pictures/${pictureId}`, this.options({
      validateStatus: (status: number) => status === 200 || status === 102 || status === 404
    }))
    if (res.status !== 200) return undefined
    return { id: res.data.id, collection: res.data.collection }
  }

  async patchPicture (pictureId: string, body: { latitude: number, longitude: number, capture_time?: string }): Promise<void> {
    await this.axios.patch(`${this.baseUrl}/api/pictures/${pictureId}`, body, this.options({ headers: { 'Content-Type': 'application/json' } }))
  }

  async deletePicture (collectionId: string, pictureId: string): Promise<void> {
    await this.axios.delete(`${this.baseUrl}/api/collections/${collectionId}/items/${pictureId}`, this.options({
      validateStatus: (status: number) => (status >= 200 && status < 300) || status === 404
    }))
  }
}
