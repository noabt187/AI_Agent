import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { TaskRequestBinding, TaskState } from '../orchestrator/types.js'

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type RunRecord = {
  id: string
  sessionId: string
  prompt: string
  status: RunStatus
  createdAt: number
  startedAt?: number
  endedAt?: number
  messageIds: string[]
  userMessageId?: string
  partialOutput?: string
  error?: string
  binding?: TaskRequestBinding
  taskId?: string
  taskRevision?: number
  taskPhase?: TaskState['phase']
}
export const isTerminalRun = (status: RunStatus): boolean => !['queued', 'running'].includes(status)

// Serial, atomic per-session snapshots. Recovery runs only once per store/process,
// never when a second reader opens an actively running session.
export class RunStore {
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly initialized = new Set<string>()
  constructor(private readonly stateDir: string) {}
  private path(sessionId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session id')
    return resolve(this.stateDir, sessionId, 'runs.json')
  }
  private async read(sessionId: string): Promise<RunRecord[]> {
    try {
      const records: unknown = JSON.parse(await readFile(this.path(sessionId), 'utf8'))
      if (!Array.isArray(records)) throw new Error('Invalid run records')
      return records as RunRecord[]
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
  }
  private async write(sessionId: string, records: RunRecord[]): Promise<void> {
    const path = this.path(sessionId)
    await mkdir(resolve(this.stateDir, sessionId), { recursive: true })
    const temp = `${path}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(records, null, 2), 'utf8')
    await rename(temp, path)
  }
  private serial<T>(sessionId: string, fn: (records: RunRecord[]) => Promise<T>): Promise<T> {
    const previous = this.chains.get(sessionId) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(async () => {
      const records = await this.read(sessionId)
      if (!this.initialized.has(sessionId)) {
        let changed = false
        for (const record of records) {
          if (!isTerminalRun(record.status)) {
            record.status = 'interrupted'; record.endedAt = Date.now(); changed = true
          }
        }
        if (changed) await this.write(sessionId, records)
        this.initialized.add(sessionId)
      }
      return fn(records)
    })
    this.chains.set(sessionId, task)
    void task.finally(() => { if (this.chains.get(sessionId) === task) this.chains.delete(sessionId) }).catch(() => {})
    return task
  }
  list(sessionId: string): Promise<RunRecord[]> {
    return this.serial(sessionId, async records => structuredClone(records))
  }
  create(sessionId: string, prompt: string, ids?: { runId: string; userMessageId: string }): Promise<RunRecord> {
    return this.serial(sessionId, async records => {
      const record: RunRecord = { id: ids?.runId ?? randomUUID(), sessionId, prompt, status: 'queued', createdAt: Date.now(), messageIds: [], userMessageId: ids?.userMessageId ?? randomUUID() }
      if (records.some(existing => existing.id === record.id)) throw new Error('Duplicate run id')
      records.push(record)
      await this.write(sessionId, records)
      return structuredClone(record)
    })
  }
  update(sessionId: string, id: string, patch: Partial<Pick<RunRecord, 'status' | 'messageIds' | 'partialOutput' | 'error' | 'binding' | 'taskId' | 'taskRevision' | 'taskPhase'>>): Promise<RunRecord> {
    return this.serial(sessionId, async records => {
      const record = records.find(item => item.id === id)
      if (!record) throw new Error('Run not found')
      if (isTerminalRun(record.status)) return structuredClone(record)
      if (record.status === 'running' && patch.status === 'queued') throw new Error('Invalid run transition')
      Object.assign(record, patch)
      if (record.status === 'running' && !record.startedAt) record.startedAt = Date.now()
      if (isTerminalRun(record.status)) record.endedAt = Date.now()
      await this.write(sessionId, records)
      return structuredClone(record)
    })
  }
}

// All entry points share initialization, so loading a CLI/HTTP session cannot
// reconcile a row that this process is already executing.
export const sessionRunStore = new RunStore(resolve(process.cwd(), 'state'))
