import { mkdir, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Orchestrator } from '../orchestrator/orchestrator.js'
import { loadMessages } from '../state/sessionStore.js'
import { isMemoryRecallMode, type MemoryRecallMode } from '../orchestrator/types.js'

const stateDir = resolve(process.cwd(), 'state')
const orchestrators = new Map<string, Orchestrator>()
const activeRuns = new Set<string>()

export async function getOrchestrator(sessionId: string): Promise<Orchestrator> {
  const existing = orchestrators.get(sessionId)
  if (existing) {
    // 验证 session 目录未被外部删除（缓存失效）
    try {
      await stat(resolve(stateDir, 'sessions', sessionId))
    } catch {
      orchestrators.delete(sessionId)
    }
    if (orchestrators.has(sessionId)) return existing
  }

  const orchestrator = await Orchestrator.load(sessionId)
  orchestrators.set(sessionId, orchestrator)
  return orchestrator
}

export function isSessionRunning(sessionId: string): boolean {
  return activeRuns.has(sessionId)
}

export function markSessionRunning(sessionId: string): void {
  activeRuns.add(sessionId)
}

export function markSessionIdle(sessionId: string): void {
  activeRuns.delete(sessionId)
}

export async function listSessions(): Promise<Array<{ id: string; updatedAt: number }>> {
  await mkdir(stateDir, { recursive: true })
  const entries = await readdir(stateDir)
  const sessions: Array<{ id: string; updatedAt: number }> = []

  for (const entry of entries) {
    if (!entry.startsWith('session-')) continue
    const fullPath = resolve(stateDir, entry)
    const info = await stat(fullPath)
    if (info.isDirectory()) {
      sessions.push({ id: entry, updatedAt: info.mtimeMs })
    }
  }

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function createSession(): Promise<string> {
  const sessions = await listSessions()
  const nums = sessions
    .map((s) => Number.parseInt(s.id.slice('session-'.length), 10))
    .filter((num) => !Number.isNaN(num))

  const nextNum = nums.length === 0 ? 1 : Math.max(...nums) + 1
  const sessionId = `session-${String(nextNum).padStart(3, '0')}`
  await mkdir(resolve(stateDir, sessionId), { recursive: true })
  return sessionId
}

export async function loadSession(sessionId: string): Promise<unknown> {
  const orchestrator = await getOrchestrator(sessionId)
  const messages = await loadMessages(sessionId)
  return {
    id: sessionId,
    running: isSessionRunning(sessionId),
    state: orchestrator.state,
    messages,
  }
}

export async function updateAllowedPaths(sessionId: string, allowedPaths: string[]): Promise<unknown> {
  const orchestrator = await getOrchestrator(sessionId)
  orchestrator.state.allowedPaths = allowedPaths
  await orchestrator.persist()
  return loadSession(sessionId)
}

export async function loadSessionMemory(sessionId: string): Promise<unknown> {
  const orchestrator = await getOrchestrator(sessionId)
  return orchestrator.getMemoryState()
}

export async function updateMemorySettings(sessionId: string, recallMode: unknown): Promise<unknown> {
  if (!isMemoryRecallMode(recallMode)) {
    throw new Error('recallMode 必须是 auto、off 或 on')
  }
  const orchestrator = await getOrchestrator(sessionId)
  await orchestrator.setMemoryRecallMode(recallMode as MemoryRecallMode)
  return loadSession(sessionId)
}

export async function addPinnedMemory(sessionId: string, content: unknown): Promise<unknown> {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('content 不能为空')
  }
  const orchestrator = await getOrchestrator(sessionId)
  const result = await orchestrator.rememberProjectMemory(content)
  return {
    ...result,
    memoryState: await orchestrator.getMemoryState(),
  }
}

export async function removePinnedMemory(sessionId: string, id: string): Promise<unknown> {
  const orchestrator = await getOrchestrator(sessionId)
  const deleted = await orchestrator.forgetProjectMemory(id)
  return {
    deleted,
    memoryState: await orchestrator.getMemoryState(),
  }
}

export async function abortSession(sessionId: string): Promise<void> {
  const orchestrator = await getOrchestrator(sessionId)
  orchestrator.abort()
}
