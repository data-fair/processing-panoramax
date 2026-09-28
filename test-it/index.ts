import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import processingConfigSchema from '../processing-config-schema.json' with { type: 'json' }
import * as panoramaxPlugin from '../index.ts'

const processingConfig = {
  datasetMode: 'create',
  datasetTitle: 'Suivi Panoramax',
  sourceDataset: { id: 'source', title: 'Photos terrain' },
  panoramaxUrl: 'https://panoramax.example.fr',
  panoramaxToken: 'secret-token'
}

describe('Panoramax processing', () => {
  it('expose un schéma de configuration pour les utilisateurs', () => {
    assert.equal(processingConfigSchema.type, 'object')
  })

  it('sort le jeton Panoramax de la configuration', async () => {
    const config: any = { ...processingConfig }
    const res = await panoramaxPlugin.prepare({ processingConfig: config, secrets: {} })
    assert.equal(res.processingConfig?.panoramaxToken, '********')
    assert.equal((res.secrets as any).panoramaxToken, 'secret-token')
  })

  it('supprime le secret quand le jeton est vidé', async () => {
    const config: any = { ...processingConfig, panoramaxToken: '' }
    const res = await panoramaxPlugin.prepare({ processingConfig: config, secrets: { panoramaxToken: 'secret-token' } })
    assert.equal((res.secrets as any).panoramaxToken, undefined)
  })
})
