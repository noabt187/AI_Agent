import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export type ModelConfig = {
  provider: 'openai' | 'anthropic'
  base_url: string
  api_key: string
  model: string
}

const configPath = resolve(process.cwd(), 'config', 'model.json')

export async function loadModelConfig(): Promise<ModelConfig> {
  const raw = await readFile(configPath, 'utf8')
  return JSON.parse(raw) as ModelConfig
}
