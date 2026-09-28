import type { PrepareFunction } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'

/**
 * Le jeton Panoramax est sorti de la configuration pour être stocké dans les secrets du traitement.
 */
const prepare: PrepareFunction<ProcessingConfig> = async ({ processingConfig, secrets }) => {
  const token = processingConfig.panoramaxToken
  if (token && token !== '********') {
    secrets.panoramaxToken = token
    processingConfig.panoramaxToken = '********'
  } else if (secrets.panoramaxToken && token === '') {
    delete secrets.panoramaxToken
  }
  return { processingConfig, secrets }
}

export default prepare
