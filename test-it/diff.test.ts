import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { diffLines, type MappingRow, type SourcePhotoLine } from '../lib/diff.ts'
import { uuidv5 } from '../lib/uuid.ts'

const line = (overrides: Partial<SourcePhotoLine> & { lineId: string }): SourcePhotoLine => ({
  photoRef: `photo-${overrides.lineId}`,
  latitude: 48.85,
  longitude: 2.35,
  ...overrides
})

const mappingRow = (overrides: Partial<MappingRow> & { lineId: string }): MappingRow => ({
  _id: `map-${overrides.lineId}`,
  photoRef: `photo-${overrides.lineId}`,
  latitude: 48.85,
  longitude: 2.35,
  status: 'ready',
  panoramaItemId: `item-${overrides.lineId}`,
  panoramaCollectionId: `col-${overrides.lineId}`,
  ...overrides
})

describe('uuidv5', () => {
  it('reproduit le vecteur de test RFC 4122', () => {
    assert.equal(uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '2ed6657d-e927-568b-95e1-2665a8aea6a2')
  })

  it('est déterministe et change avec le nom', () => {
    assert.equal(uuidv5('a'), uuidv5('a'))
    assert.notEqual(uuidv5('a'), uuidv5('b'))
  })
})

describe('diffLines', () => {
  it('envoie une photo nouvelle', () => {
    const diff = diffLines([line({ lineId: 'a' })], [])
    assert.equal(diff.toUpload.length, 1)
    assert.equal(diff.toUpload[0].line.lineId, 'a')
    assert.deepEqual(diff.toPatch, [])
    assert.deepEqual(diff.toDelete, [])
    assert.equal(diff.unchanged, 0)
  })

  it('ne touche pas à une photo inchangée', () => {
    const diff = diffLines([line({ lineId: 'a' })], [mappingRow({ lineId: 'a' })])
    assert.deepEqual(diff.toUpload, [])
    assert.deepEqual(diff.toPatch, [])
    assert.deepEqual(diff.toDelete, [])
    assert.equal(diff.unchanged, 1)
  })

  it('renvoie en upload une photo remplacée, en conservant la ligne précédente', () => {
    const diff = diffLines([line({ lineId: 'a', photoRef: 'nouvelle' })], [mappingRow({ lineId: 'a' })])
    assert.equal(diff.toUpload.length, 1)
    assert.equal(diff.toUpload[0].previous?.panoramaItemId, 'item-a')
  })

  it('renvoie en upload une synchronisation précédemment en erreur', () => {
    const diff = diffLines([line({ lineId: 'a' })], [mappingRow({ lineId: 'a', status: 'error', panoramaItemId: undefined })])
    assert.equal(diff.toUpload.length, 1)
  })

  it('met à jour la position sans réenvoyer la photo', () => {
    const diff = diffLines([line({ lineId: 'a', latitude: 48.9 })], [mappingRow({ lineId: 'a' })])
    assert.equal(diff.toUpload.length, 0)
    assert.equal(diff.toPatch.length, 1)
    assert.equal(diff.toPatch[0].mapping.panoramaItemId, 'item-a')
  })

  it('supprime une ligne source disparue', () => {
    const diff = diffLines([], [mappingRow({ lineId: 'a' })])
    assert.equal(diff.toDelete.length, 1)
    assert.equal(diff.toDelete[0].lineId, 'a')
  })

  it('supprime la photo retirée d\'une ligne toujours présente', () => {
    const diff = diffLines([line({ lineId: 'a', photoRef: null })], [mappingRow({ lineId: 'a' })])
    assert.equal(diff.toDelete.length, 1)
  })

  it('ignore une photo sans position et ne supprime rien', () => {
    const diff = diffLines([line({ lineId: 'a', latitude: null, longitude: null })], [mappingRow({ lineId: 'a' })])
    assert.deepEqual(diff.toUpload, [])
    assert.deepEqual(diff.toDelete, [])
    assert.equal(diff.skipped, 1)
  })
})
