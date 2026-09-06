import type { AgentEvent } from '../orchestrator/types.js'

export interface PromptJob {
  sessionId: string
  prompt: string
  userMessageId?: string
  onStart?(): void | Promise<void>
  onEvent(event: AgentEvent): void | Promise<void>
  signal?: AbortSignal
  onAccepted?(): void | Promise<void>
  onFinish?(error: unknown, signal?: AbortSignal): void | Promise<void>
}

interface QueuedPrompt {
  job: PromptJob
  resolve(): void
  reject(error: unknown): void
}

export class PromptQueueError extends Error {
  constructor(message: string, public readonly code: 'PROMPT_ABORTED' | 'SESSION_DELETED') {
    super(message)
  }
}

export class SessionPromptQueue {
  private readonly pending = new Map<string, QueuedPrompt[]>()
  private readonly active = new Map<string, { prompt: QueuedPrompt; settled: Promise<void>; controller: AbortController }>()

  constructor(
    private readonly execute: (job: PromptJob) => Promise<void>,
    private readonly abortActive: (sessionId: string) => void | Promise<void> = () => {},
  ) {}

  enqueue(job: PromptJob): Promise<void> {
    if (job.signal?.aborted) {
      return Promise.reject(new PromptQueueError('Prompt was aborted before admission', 'PROMPT_ABORTED'))
    }
    const promise = new Promise<void>((resolve, reject) => {
      const queue = this.pending.get(job.sessionId) ?? []
      queue.push({ job, resolve, reject })
      this.pending.set(job.sessionId, queue)
    })
    this.startNext(job.sessionId)
    return promise
  }

  async abort(sessionId: string): Promise<void> {
    const current = this.active.get(sessionId)
    if (!current) return
    current.controller.abort()
    await this.abortActive(sessionId)
    await current.settled
  }

  async delete(sessionId: string): Promise<void> {
    const queued = this.pending.get(sessionId) ?? []
    this.pending.delete(sessionId)
    const error = new PromptQueueError(`Session ${sessionId} was deleted`, 'SESSION_DELETED')
    for (const item of queued) {
      try { await item.job.onFinish?.(error, item.job.signal) } catch {}
      item.reject(error)
    }
    const active = this.active.get(sessionId)
    if (active === undefined) return
    active.controller.abort()
    await this.abortActive(sessionId)
    await active.settled.catch(() => {})
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  queued(sessionId: string): number {
    return this.pending.get(sessionId)?.length ?? 0
  }

  private startNext(sessionId: string): void {
    if (this.active.has(sessionId)) return
    const queue = this.pending.get(sessionId)
    const prompt = queue?.shift()
    if (prompt === undefined) {
      this.pending.delete(sessionId)
      return
    }
    if (queue?.length === 0) this.pending.delete(sessionId)
    let markSettled!: () => void
    const settled = new Promise<void>(resolve => { markSettled = resolve })
    const controller = new AbortController()
    prompt.job = { ...prompt.job, signal: prompt.job.signal ? AbortSignal.any([controller.signal, prompt.job.signal]) : controller.signal }
    this.active.set(sessionId, { prompt, settled, controller })
    void this.run(prompt).finally(() => {
      this.active.delete(sessionId)
      markSettled()
      this.startNext(sessionId)
    })
  }

  private async run(item: QueuedPrompt): Promise<void> {
    let failure: unknown
    try {
      if (item.job.signal?.aborted) {
        throw new PromptQueueError('Prompt was aborted before execution', 'PROMPT_ABORTED')
      }
      await item.job.onStart?.()
      await this.execute(item.job)
    } catch (error) {
      failure = error
    }
    try { await item.job.onFinish?.(failure, item.job.signal) } catch (error) { failure = error }
    if (failure !== undefined) item.reject(failure)
    else item.resolve()
  }
}
