import type { TextFormat } from './text-format.ts'

export interface SourceDraftScope {
  sessionId: string
  rootPath: string
  selectedFolder: string
  path: string
}

export interface SourceDraftRecord extends SourceDraftScope {
  key: string
  baseHash: string
  content: string
  format?: TextFormat
  revision: number
  updatedAt: number
}

export interface SourceDraftStorage {
  get(key: string): Promise<SourceDraftRecord | undefined>
  put(record: SourceDraftRecord): Promise<void>
  delete(key: string): Promise<void>
  deleteIfRevision(key: string, revision: number): Promise<boolean>
  list(): Promise<SourceDraftRecord[]>
}

export type DraftRestore =
  | { kind: 'none' }
  | { kind: 'recovered'; content: string; revision: number; format?: TextFormat }
  | { kind: 'conflict'; content: string; revision: number; baseHash: string; diskHash: string; format?: TextFormat }

export type DraftPersistResult =
  | { ok: true; revision: number }
  | { ok: false; error: Error }

export function diskSaveStatus(path: string, hasNewerEdit: boolean, persistenceWarning: string | null): string {
  if (persistenceWarning !== null) return persistenceWarning
  return hasNewerEdit
    ? `已保存 ${path} 的先前版本；较新的修改仍未保存。`
    : `已保存 ${path}。正在同步预览…`
}

export async function draftAfterQueuedOperation(
  previousDraft: string,
  operation: () => Promise<unknown>,
  readCurrentDraft: () => string | undefined,
): Promise<{ newerDraft: string | null; error: Error | null }> {
  let error: Error | null = null
  try {
    await operation()
  } catch (cause) {
    error = cause instanceof Error ? cause : new Error(String(cause))
  }
  const current = readCurrentDraft()
  return { newerDraft: current !== undefined && current !== previousDraft ? current : null, error }
}

const MAX_DRAFT_BYTES = 1_000_000
const MAX_DRAFTS = 100

function canonicalPart(value: string, root = false): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/\/+$/, '')
  return root && /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized
}

export function sourceDraftKey(scope: SourceDraftScope): string {
  return ['v1', scope.sessionId, canonicalPart(scope.rootPath, true), canonicalPart(scope.selectedFolder), canonicalPart(scope.path)]
    .map(encodeURIComponent)
    .join(':')
}

export function isDraftCacheAllowed(path: string): boolean {
  const name = path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? ''
  if (name === '.env' || name.startsWith('.env.')) return false
  if (/^(id_(rsa|dsa|ecdsa|ed25519))(\.|$)/.test(name)) return false
  if (/(^|[._-])(?:client[._-]?secret|private[._-]?key|api[._-]?key|service[._-]?account|credentials?|secrets?)(?:[._-]|$)/.test(name)) return false
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(name)) return false
  return true
}

export class SourceDraftCache {
  private readonly writes = new Map<string, Promise<void>>()
  constructor(private readonly storage: SourceDraftStorage) {}

  private async queued<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => gate)
    this.writes.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.writes.get(key) === tail) this.writes.delete(key)
    }
  }

  async persist(scope: SourceDraftScope, baseHash: string, content: string, format?: TextFormat): Promise<DraftPersistResult> {
    const key = sourceDraftKey(scope)
    try {
      return await this.queued(key, async () => {
        if (!isDraftCacheAllowed(scope.path)) throw new Error('敏感文件草稿不会缓存在浏览器中。')
        if (new TextEncoder().encode(content).byteLength > MAX_DRAFT_BYTES) throw new Error('草稿超过 1 MB 浏览器缓存上限。')
        const previous = await this.storage.get(key)
        const records = await this.storage.list()
        if (previous === undefined && records.length >= MAX_DRAFTS) throw new Error('浏览器中已有 100 份未保存草稿；请先保存或丢弃一份。')
        const revision = (previous?.revision ?? 0) + 1
        await this.storage.put({ ...scope, key, baseHash, content, ...(format === undefined ? {} : { format }), revision, updatedAt: Date.now() })
        return { ok: true, revision }
      })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
    }
  }

  async restore(scope: SourceDraftScope, diskHash: string): Promise<DraftRestore> {
    if (!isDraftCacheAllowed(scope.path)) return { kind: 'none' }
    return this.queued(sourceDraftKey(scope), async () => {
      const record = await this.storage.get(sourceDraftKey(scope))
      if (record === undefined) return { kind: 'none' }
      const format = record.format === undefined ? {} : { format: record.format }
      if (record.baseHash === diskHash) return { kind: 'recovered', content: record.content, revision: record.revision, ...format }
      return { kind: 'conflict', content: record.content, revision: record.revision, baseHash: record.baseHash, diskHash, ...format }
    })
  }

  clearSaved(scope: SourceDraftScope, revision: number): Promise<boolean> {
    const key = sourceDraftKey(scope)
    return this.queued(key, () => this.storage.deleteIfRevision(key, revision))
  }

  // Also covers a write queued before save whose revision is not known to the UI yet.
  clearMatching(scope: SourceDraftScope, baseHash: string, content: string): Promise<boolean> {
    const key = sourceDraftKey(scope)
    return this.queued(key, async () => {
      const record = await this.storage.get(key)
      if (record === undefined || record.baseHash !== baseHash || record.content !== content) return false
      return this.storage.deleteIfRevision(key, record.revision)
    })
  }

  discard(scope: SourceDraftScope): Promise<void> {
    const key = sourceDraftKey(scope)
    return this.queued(key, () => this.storage.delete(key))
  }
}

export class MemoryDraftStorage implements SourceDraftStorage {
  readonly records = new Map<string, SourceDraftRecord>()
  failure: Error | null = null
  private check(): void { if (this.failure !== null) throw this.failure }
  async get(key: string): Promise<SourceDraftRecord | undefined> { this.check(); return this.records.get(key) }
  async put(record: SourceDraftRecord): Promise<void> { this.check(); this.records.set(record.key, structuredClone(record)) }
  async delete(key: string): Promise<void> { this.check(); this.records.delete(key) }
  async deleteIfRevision(key: string, revision: number): Promise<boolean> {
    this.check()
    if (this.records.get(key)?.revision !== revision) return false
    this.records.delete(key)
    return true
  }
  async list(): Promise<SourceDraftRecord[]> { this.check(); return Array.from(this.records.values()) }
}

export class IndexedDbDraftStorage implements SourceDraftStorage {
  private readonly database: Promise<IDBDatabase>
  constructor(indexedDb: IDBFactory = window.indexedDB) {
    this.database = new Promise((resolve, reject) => {
      const request = indexedDb.open('dsh-pagecraft-source-drafts', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'key' })
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('无法打开浏览器草稿数据库。'))
    })
  }
  private async request<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.database
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('drafts', mode)
      const request = action(transaction.objectStore('drafts'))
      let result: T
      request.onsuccess = () => { result = request.result }
      request.onerror = () => reject(request.error ?? new Error('浏览器草稿存储失败。'))
      transaction.oncomplete = () => resolve(result)
      transaction.onerror = () => reject(transaction.error ?? new Error('浏览器草稿事务失败。'))
      transaction.onabort = () => reject(transaction.error ?? new Error('浏览器草稿事务失败。'))
    })
  }
  get(key: string): Promise<SourceDraftRecord | undefined> { return this.request('readonly', store => store.get(key)) }
  async put(record: SourceDraftRecord): Promise<void> { await this.request('readwrite', store => store.put(record)) }
  async delete(key: string): Promise<void> { await this.request('readwrite', store => store.delete(key)) }
  list(): Promise<SourceDraftRecord[]> { return this.request('readonly', store => store.getAll()) }
  async deleteIfRevision(key: string, revision: number): Promise<boolean> {
    const db = await this.database
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('drafts', 'readwrite')
      const store = transaction.objectStore('drafts')
      const get = store.get(key)
      let removed = false
      get.onsuccess = () => {
        if ((get.result as SourceDraftRecord | undefined)?.revision === revision) {
          store.delete(key)
          removed = true
        }
      }
      transaction.oncomplete = () => resolve(removed)
      transaction.onerror = () => reject(transaction.error ?? new Error('浏览器草稿清理失败。'))
      transaction.onabort = () => reject(transaction.error ?? new Error('浏览器草稿清理失败。'))
    })
  }
}
