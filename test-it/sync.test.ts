import { strict as assert } from 'node:assert'
import { describe, it, beforeEach, mock } from 'node:test'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import axios from 'axios'
import nock from 'nock'
import * as panoramaxPlugin from '../index.ts'
import { uuidv5 } from '../lib/uuid.ts'

const sourceDataset = {
  id: 'source',
  title: 'Photos terrain',
  isRest: true,
  schema: [
    { key: 'photo', type: 'string', 'x-refersTo': 'http://schema.org/DigitalDocument' },
    { key: 'geometry', type: 'object', 'x-refersTo': 'https://purl.org/geojson/vocab#geometry' },
    { key: 'prise_le', type: 'string' }
  ]
}

const baseConfig = {
  datasetMode: 'create',
  datasetTitle: 'Suivi Panoramax',
  sourceDataset: { id: 'source', title: 'Photos terrain' },
  photoField: 'photo',
  dateField: 'prise_le',
  panoramaxUrl: 'http://panoramax.test',
  panoramaxToken: '********',
  visibility: 'anyone'
}

const makeContext = (overrides: any = {}) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panoramax-test-'))
  const processingConfig = { ...baseConfig, ...overrides.processingConfig }
  const log = {
    step: mock.fn(async () => {}),
    info: mock.fn(async () => {}),
    warning: mock.fn(async () => {}),
    error: mock.fn(async () => {}),
    debug: mock.fn(async () => {}),
    progress: mock.fn(async () => {})
  }
  const patchConfig = mock.fn(async () => {})
  const context: any = {
    processingConfig,
    secrets: overrides.secrets ?? { panoramaxToken: 'jwt-token' },
    processingId: 'processing-1',
    tmpDir,
    axios: axios.create({ baseURL: 'http://datafair.test' }),
    log,
    patchConfig
  }
  return { context, log, patchConfig }
}

const mockSourceDataset = () => {
  nock('http://datafair.test').get('/api/v1/datasets/source').reply(200, sourceDataset)
}

const mockCompanionCreation = () => {
  const bodies: any[] = []
  nock('http://datafair.test').post('/api/v1/datasets').reply(200, function (uri, body) {
    bodies.push(typeof body === 'string' ? JSON.parse(body) : body)
    return { id: 'companion', title: 'Suivi Panoramax' }
  })
  return bodies
}

const mockCompanionLines = (rows: any[]) => {
  nock('http://datafair.test')
    .get('/api/v1/datasets/companion/lines')
    .query(true)
    .reply(200, { results: rows, total: rows.length })
}

describe('synchronisation complète', () => {
  beforeEach(() => {
    nock.cleanAll()
  })

  it('téléverse les nouvelles photos, met à jour le suivi et supprime les photos orphelines', async () => {
    const pictureId = uuidv5('source:line1:line1/abc/photo.jpg')
    mockSourceDataset()
    const companionBodies = mockCompanionCreation()
    mockCompanionLines([
      {
        _id: 'map2',
        lineId: 'line2',
        photoRef: 'line2/def/photo.jpg',
        latitude: 48.86,
        longitude: 2.36,
        capturedAt: '2026-01-02T11:00:00.000Z',
        status: 'ready',
        panoramaItemId: 'item2',
        panoramaCollectionId: 'col2'
      },
      { _id: 'mapOld', lineId: 'lineOld', photoRef: 'old/x/photo.jpg', status: 'ready', panoramaItemId: 'itemOld', panoramaCollectionId: 'colOld' }
    ])
    nock('http://datafair.test')
      .get('/api/v1/datasets/source/lines')
      .query(true)
      .reply(200, {
        results: [
          { _id: 'line1', photo: 'line1/abc/photo.jpg', geometry: { type: 'Point', coordinates: [2.35, 48.85] }, prise_le: '2026-01-02T10:00:00Z' },
          { _id: 'line2', photo: 'line2/def/photo.jpg', geometry: { type: 'Point', coordinates: [2.36, 48.86] }, prise_le: '2026-01-02T11:00:00Z' }
        ],
        total: 2
      })
    nock('http://datafair.test').get('/api/v1/datasets/source/attachments/line1/abc/photo.jpg').reply(200, 'fake-jpeg')

    nock('http://panoramax.test').post('/api/upload_sets').reply(200, { id: 'us1' })
    nock('http://panoramax.test').post('/api/upload_sets/us1/files').reply(200, {})
    nock('http://panoramax.test').post('/api/upload_sets/us1/complete').reply(200, {})
    nock('http://panoramax.test').get('/api/upload_sets/us1').reply(200, { ready: true, associated_collections: [{ id: 'col1' }] })
    nock('http://panoramax.test').get('/api/upload_sets/us1/files').reply(200, {
      files: [{ file_name: 'line1.jpg', picture_id: pictureId }]
    })
    nock('http://panoramax.test').get('/api/collections/col1/items').query(true).reply(200, {
      features: [{ id: pictureId, collection: 'col1' }],
      links: []
    })
    nock('http://panoramax.test').delete('/api/collections/colOld/items/itemOld').reply(204)

    let bulkActions: any[] = []
    nock('http://datafair.test').post('/api/v1/datasets/companion/_bulk_lines').reply(200, function (uri, body) {
      bulkActions = typeof body === 'string' ? JSON.parse(body) : body
      return { nbOk: bulkActions.length, nbErrors: 0 }
    })

    const { context, patchConfig } = makeContext()
    await panoramaxPlugin.run(context)

    assert.equal(patchConfig.mock.callCount(), 1)
    assert.deepEqual(patchConfig.mock.calls[0].arguments[0], { datasetMode: 'update', dataset: { id: 'companion', title: 'Suivi Panoramax' } })
    assert.equal(companionBodies[0].isRest, true)
    assert.equal(companionBodies[0].extras.panoramaxSync.sourceDatasetId, 'source')

    const createAction = bulkActions.find((action: any) => action.lineId === 'line1')
    assert.equal(createAction._action, 'create')
    assert.equal(createAction.status, 'ready')
    assert.equal(createAction.panoramaItemId, pictureId)
    assert.equal(createAction.panoramaCollectionId, 'col1')
    assert.equal(createAction.latitude, 48.85)
    assert.equal(createAction.capturedAt, '2026-01-02T10:00:00.000Z')

    assert.equal(bulkActions.some((action: any) => action.lineId === 'line2'), false)
    const deleteAction = bulkActions.find((action: any) => action._action === 'delete')
    assert.equal(deleteAction._id, 'mapOld')
    assert.equal(nock.isDone(), true)
  })

  it('adopte une photo déjà présente (reprise après interruption)', async () => {
    const pictureId = uuidv5('source:line1:line1/abc/photo.jpg')
    mockSourceDataset()
    mockCompanionCreation()
    mockCompanionLines([])
    nock('http://datafair.test')
      .get('/api/v1/datasets/source/lines')
      .query(true)
      .reply(200, {
        results: [{ _id: 'line1', photo: 'line1/abc/photo.jpg', geometry: { type: 'Point', coordinates: [2.35, 48.85] } }],
        total: 1
      })
    nock('http://datafair.test').get('/api/v1/datasets/source/attachments/line1/abc/photo.jpg').reply(200, 'fake-jpeg')

    nock('http://panoramax.test').post('/api/upload_sets').reply(200, { id: 'us1' })
    nock('http://panoramax.test').post('/api/upload_sets/us1/files').reply(200, {})
    nock('http://panoramax.test').post('/api/upload_sets/us1/complete').reply(200, {})
    nock('http://panoramax.test').get('/api/upload_sets/us1').reply(200, { ready: true, associated_collections: [{ id: 'col1' }] })
    nock('http://panoramax.test').get('/api/upload_sets/us1/files').reply(200, {
      files: [{ file_name: 'line1.jpg', picture_id: pictureId, rejected: { reason: 'invalid_id', message: 'id already exists' } }]
    })
    nock('http://panoramax.test').get('/api/collections/col1/items').query(true).reply(200, { features: [], links: [] })
    nock('http://panoramax.test').get(`/api/pictures/${pictureId}`).reply(200, { id: pictureId, collection: 'colExisting' })

    let bulkActions: any[] = []
    nock('http://datafair.test').post('/api/v1/datasets/companion/_bulk_lines').reply(200, function (uri, body) {
      bulkActions = typeof body === 'string' ? JSON.parse(body) : body
      return { nbOk: bulkActions.length, nbErrors: 0 }
    })

    const { context } = makeContext()
    await panoramaxPlugin.run(context)

    const action = bulkActions.find((a: any) => a.lineId === 'line1')
    assert.equal(action.status, 'ready')
    assert.equal(action.panoramaCollectionId, 'colExisting')
    assert.equal(action.error, undefined)
    assert.equal(nock.isDone(), true)
  })

  it('met à jour la position d\'une photo déjà synchronisée sans la réenvoyer', async () => {
    mockSourceDataset()
    mockCompanionCreation()
    mockCompanionLines([
      {
        _id: 'map1',
        lineId: 'line1',
        photoRef: 'line1/abc/photo.jpg',
        latitude: 48.85,
        longitude: 2.35,
        status: 'ready',
        panoramaItemId: 'item1',
        panoramaCollectionId: 'col1'
      }
    ])
    nock('http://datafair.test')
      .get('/api/v1/datasets/source/lines')
      .query(true)
      .reply(200, {
        results: [{ _id: 'line1', photo: 'line1/abc/photo.jpg', geometry: { type: 'Point', coordinates: [2.35, 48.9] } }],
        total: 1
      })

    let patchedBody: any
    nock('http://panoramax.test').patch('/api/pictures/item1').reply(200, function (uri, body) {
      patchedBody = typeof body === 'string' ? JSON.parse(body) : body
      return {}
    })

    let bulkActions: any[] = []
    nock('http://datafair.test').post('/api/v1/datasets/companion/_bulk_lines').reply(200, function (uri, body) {
      bulkActions = typeof body === 'string' ? JSON.parse(body) : body
      return { nbOk: bulkActions.length, nbErrors: 0 }
    })

    const { context } = makeContext()
    await panoramaxPlugin.run(context)

    assert.equal(patchedBody.latitude, 48.9)
    assert.equal(patchedBody.longitude, 2.35)
    assert.equal(bulkActions.length, 1)
    assert.equal(bulkActions[0]._action, 'update')
    assert.equal(bulkActions[0]._id, 'map1')
    assert.equal(bulkActions[0].status, 'ready')
    assert.equal(nock.isDone(), true)
  })
})
