import { mkdir, readFile, writeFile, rename, copyFile, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { normalizeTaskState } from '../orchestrator/taskPersistence.js'
import { resolve } from 'node:path'
import type { Message } from '../types/index.js'

const stateDir = resolve(process.cwd(), 'state')

function getSessionDir(sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session id')
  return resolve(stateDir, sessionId)
}

function getMessagesPath(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'messages.json')
}

function getMessagesBackupPath(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'messages-full.json')
}

function getOrchestratorStatePath(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'orchestrator-state.json')
}

function getSessionMetaPath(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'meta.json')
}

export type SessionMeta = {
  title?: string
}

export async function loadMessages(sessionId: string): Promise<Message[]> {
  const path = getMessagesPath(sessionId)
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function saveMessages(sessionId: string, messages: Message[]): Promise<void> {
  const sessionDir = getSessionDir(sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(getMessagesPath(sessionId), JSON.stringify(messages, null, 2), 'utf8')
}

export async function saveMessagesBackup(sessionId: string, messages: Message[]): Promise<void> {
  const sessionDir = getSessionDir(sessionId)
  await mkdir(sessionDir, { recursive: true })
  const path = getMessagesBackupPath(sessionId)
  // Append to backup: merge with existing, dedup by uuid
  let existing: Message[] = []
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) existing = parsed
  } catch {}
  const existingIds = new Set(existing.map((m) => m.uuid))
  const newMessages = messages.filter((m) => !existingIds.has(m.uuid))
  if (newMessages.length > 0) {
    existing.push(...newMessages)
    await writeFile(path, JSON.stringify(existing, null, 2), 'utf8')
  }
}

const stateWrites = new Map<string, Promise<void>>()

export async function loadOrchestratorState<T = import('../orchestrator/types.js').WorldState>(sessionId: string): Promise<T | null> {
  const path = getOrchestratorStatePath(sessionId)
  try {
    const raw = await readFile(path, 'utf8')
    const state = normalizeTaskState(JSON.parse(raw.replace(/^\uFEFF/, '')))
    if (state.sessionId !== sessionId) throw new Error('任务状态 sessionId 不匹配')
    return state as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function saveOrchestratorState<T>(sessionId: string, state: T): Promise<void> {
  const snapshot = normalizeTaskState(state)
  if (snapshot.sessionId !== sessionId) throw new Error('任务状态 sessionId 不匹配')
  const serialized = JSON.stringify(snapshot, null, 2)
  const previous = stateWrites.get(sessionId) ?? Promise.resolve()
  const pending = previous.catch(() => {}).then(async () => {
    const sessionDir = getSessionDir(sessionId)
    await mkdir(sessionDir, { recursive: true })
    const path = getOrchestratorStatePath(sessionId)
    try {
      const raw = await readFile(path, 'utf8')
      const existing = JSON.parse(raw.replace(/^\uFEFF/, ''))
      normalizeTaskState(existing)
      if (existing.schemaVersion === undefined) {
        try { await copyFile(path, `${path}.legacy.bak`, constants.COPYFILE_EXCL) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const temp = `${path}.${randomUUID()}.tmp`
    try { await writeFile(temp, serialized, 'utf8'); await rename(temp, path) }
    finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  })
  stateWrites.set(sessionId, pending)
  try { await pending } finally { if (stateWrites.get(sessionId) === pending) stateWrites.delete(sessionId) }
}

export async function loadSessionMeta(sessionId: string): Promise<SessionMeta> {
  try {
    const raw = await readFile(getSessionMetaPath(sessionId), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return typeof parsed.title === 'string' ? { title: parsed.title } : {}
  } catch {
    return {}
  }
}

export async function saveSessionMeta(sessionId: string, meta: SessionMeta): Promise<void> {
  const sessionDir = getSessionDir(sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(getSessionMetaPath(sessionId), JSON.stringify(meta, null, 2), 'utf8')
}

// ── Compression Failure Counter (Circuit Breaker) ───────────────────

function getCompressionFailuresPath(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'compression-failures.json')
}

export async function getCompressionFailureCount(sessionId: string): Promise<number> {
  const path = getCompressionFailuresPath(sessionId)
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed.count === 'number' ? parsed.count : 0
  } catch {
    return 0
  }
}

export async function incrementCompressionFailure(sessionId: string): Promise<number> {
  const sessionDir = getSessionDir(sessionId)
  await mkdir(sessionDir, { recursive: true })
  const count = (await getCompressionFailureCount(sessionId)) + 1
  await writeFile(getCompressionFailuresPath(sessionId), JSON.stringify({ count }), 'utf8')
  return count
}

export async function resetCompressionFailures(sessionId: string): Promise<void> {
  const sessionDir = getSessionDir(sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(getCompressionFailuresPath(sessionId), JSON.stringify({ count: 0 }), 'utf8')
}
