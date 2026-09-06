import { Service, type Context } from '@deepseek-ai/cordis'
import type { PromptResult, TextContent } from './types'

export interface BrowserSessionBindingSource {
  getRunning(): boolean
  prompt(text: string): Promise<PromptResult>
}

export interface BrowserSessionFacade {
  prompt(content: TextContent[], mode: 'queue'): Promise<PromptResult>
  subscribe(listener: () => void): () => void
  getSnapshot(): { running: boolean }
}

export interface BrowserSessionBinding {
  session: BrowserSessionFacade
}

interface BindingRecord {
  source: BrowserSessionBindingSource
  binding: BrowserSessionBinding
  snapshot: { running: boolean }
  listeners: Set<() => void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessions: BrowserSessionService
  }
}

export class BrowserSessionService extends Service {
  private readonly records = new Map<string, BindingRecord>()

  constructor(ctx: Context) {
    super(ctx, 'sessions')
  }

  bind(id: string, source: BrowserSessionBindingSource): () => void {
    if (!id) throw new Error('browser-sessions: binding id must be non-empty')
    if (this.records.has(id)) throw new Error(`browser-sessions: session "${id}" is already bound`)
    const listeners = new Set<() => void>()
    const record = {} as BindingRecord
    const session: BrowserSessionFacade = {
      prompt: (content, mode) => this.submit(record, content, mode),
      subscribe: listener => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      getSnapshot: () => record.snapshot,
    }
    Object.assign(record, {
      source,
      listeners,
      snapshot: { running: Boolean(source.getRunning()) },
      binding: { session },
    })
    this.records.set(id, record)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.records.get(id) === record) this.records.delete(id)
      listeners.clear()
    }
  }

  binding(id: string): BrowserSessionBinding | undefined {
    return this.records.get(id)?.binding
  }

  notifyRunningChanged(id: string): void {
    const record = this.records.get(id)
    if (record === undefined) return
    const running = Boolean(record.source.getRunning())
    if (record.snapshot.running === running) return
    record.snapshot = { running }
    for (const listener of [...record.listeners]) listener()
  }

  private async submit(
    record: BindingRecord,
    content: TextContent[],
    mode: 'queue',
  ): Promise<PromptResult> {
    if (mode !== 'queue') {
      return { ok: false, error: { message: 'AI Agent browser session supports queue prompt mode only' } }
    }
    if (!Array.isArray(content) || content.length === 0 || content.some(item =>
      !item || item.type !== 'text' || typeof item.text !== 'string' || item.text.trim() === '')) {
      return { ok: false, error: { message: 'AI Agent browser session supports text prompt content only' } }
    }
    const text = content.map(item => item.text.trim()).join('\n')
    try {
      return await record.source.prompt(text)
    } catch (error) {
      return {
        ok: false,
        error: { message: error instanceof Error ? error.message : String(error) },
      }
    }
  }
}

export const sessionsPlugin = BrowserSessionService
export default BrowserSessionService
