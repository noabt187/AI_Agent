import type { ModelConfig } from '../context/modelConfig.js'
import { createOpenAiClient } from './openaiClient.js'
import { createAnthropicClient } from './anthropicClient.js'
import type { LlmClient } from './types.js'

export function createLlmClient(cfg: ModelConfig): LlmClient {
  if (cfg.provider === 'anthropic') {
    return createAnthropicClient(cfg.base_url, cfg.api_key, cfg.model)
  }
  return createOpenAiClient(cfg.base_url, cfg.api_key, cfg.model)
}
