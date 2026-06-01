import type { ModelConfig } from '../context/modelConfig.js'
import { createOpenAiClient } from './openaiClient.js'
import { createAnthropicClient } from './anthropicClient.js'
import { createMonitoredClient } from './monitoredClient.js'
import type { LlmClient } from './types.js'
import type { MetricCallback } from './monitoredClient.js'

export type { MetricCallback }

export function createLlmClient(cfg: ModelConfig, onMetric?: MetricCallback): LlmClient {
  let client: LlmClient
  if (cfg.provider === 'anthropic') {
    client = createAnthropicClient(cfg.base_url, cfg.api_key, cfg.model)
  } else {
    client = createOpenAiClient(cfg.base_url, cfg.api_key, cfg.model)
  }
  if (onMetric) {
    return createMonitoredClient(client, onMetric)
  }
  return client
}
