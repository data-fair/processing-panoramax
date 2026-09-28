import { createHash } from 'node:crypto'

/** Espace de noms fixe du plugin, utilisé pour dériver des identifiants Panoramax déterministes. */
const NAMESPACE = '8b9b1c5e-2c47-4f1a-9c28-52a2c2f5d0b6'

/**
 * UUID v5 (SHA-1, RFC 4122). Permet de retrouver le même identifiant Panoramax
 * pour une même ligne et une même version de photo, sans stocker de correspondance.
 */
export const uuidv5 = (name: string, namespace: string = NAMESPACE): string => {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const digest = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
