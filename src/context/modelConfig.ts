import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export type ModelConfig = {
  provider: 'openai' | 'anthropic'
  base_url: string
  api_key: string
  model: string
  compressionModel?: string | Partial<ModelConfig>
  memoryModel?: string | Partial<ModelConfig>
}

export type ModelConfigRole = 'main' | 'compression' | 'memory'

function applyModelOverride(cfg: ModelConfig, override?: string | Partial<ModelConfig>): ModelConfig {
  if (!override) return cfg
  if (typeof override === 'string') {
    return { ...cfg, model: override }
  }
  return {
    ...cfg,
    ...override,
    provider: override.provider ?? cfg.provider,
    base_url: override.base_url ?? cfg.base_url,
    api_key: override.api_key ?? cfg.api_key,
    model: override.model ?? cfg.model,
  }
}

export async function loadModelConfig(role: ModelConfigRole = 'main'): Promise<ModelConfig> {
  const configPath = resolve(process.cwd(), 'config', 'model.json')
  const raw = await readFile(configPath, 'utf8')
  const cfg = JSON.parse(raw) as ModelConfig
  if (role === 'compression') return applyModelOverride(cfg, cfg.compressionModel)
  if (role === 'memory') return applyModelOverride(cfg, cfg.memoryModel)
  return cfg
}
