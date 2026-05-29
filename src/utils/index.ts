import { randomUUID } from 'node:crypto'
import type { ContentBlockParam } from '../types/index.js'

export function newUuid(): string {
  return randomUUID()
}

export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '')
  const p = path.replace(/^\/+/, '')
  return `${b}/${p}`
}

export function toTextPrompt(prompt: string | ContentBlockParam[]): string {
  if (typeof prompt === 'string') return prompt
  return prompt.map((b) => (b.type === 'text' ? b.text : '')).join('')
}
