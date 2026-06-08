import { spawn } from 'node:child_process'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Orchestrator } from '../orchestrator/orchestrator.js'
import { loadMessages, loadSessionMeta, saveSessionMeta } from '../state/sessionStore.js'
import { isMemoryRecallMode, normalizeRepositoryConfig, type MemoryRecallMode, type RepositoryConfig } from '../orchestrator/types.js'
import { isMemoryLayerId, isMemoryType } from '../memory/projectMemory.js'

const stateDir = resolve(process.cwd(), 'state')
const orchestrators = new Map<string, Orchestrator>()
const activeRuns = new Set<string>()

function revealPath(filePath: string): Promise<void> {
  return new Promise((resolveReveal, reject) => {
    let command: string
    let args: string[]
    if (process.platform === 'win32') {
      command = 'explorer.exe'
      args = [`/select,${filePath}`]
    } else if (process.platform === 'darwin') {
      command = 'open'
      args = ['-R', filePath]
    } else {
      command = 'xdg-open'
      args = [dirname(filePath)]
    }
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolveReveal()
    })
  })
}

export async function getOrchestrator(sessionId: string): Promise<Orchestrator> {
  const existing = orchestrators.get(sessionId)
  if (existing) {
    // 验证 session 目录未被外部删除（缓存失效）
    try {
      await stat(resolve(stateDir, sessionId))
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

export async function listSessions(): Promise<Array<{ id: string; title?: string; updatedAt: number }>> {
  await mkdir(stateDir, { recursive: true })
  const entries = await readdir(stateDir)
  const sessions: Array<{ id: string; title?: string; updatedAt: number }> = []

  for (const entry of entries) {
    if (!entry.startsWith('session-')) continue
    const fullPath = resolve(stateDir, entry)
    const info = await stat(fullPath)
    if (info.isDirectory()) {
      const meta = await loadSessionMeta(entry)
      sessions.push({ id: entry, title: meta.title, updatedAt: info.mtimeMs })
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
  const meta = await loadSessionMeta(sessionId)
  return {
    id: sessionId,
    title: meta.title,
    running: isSessionRunning(sessionId),
    state: orchestrator.state,
    messages,
  }
}

export async function loadSessionExport(sessionId: string): Promise<{
  id: string
  title?: string
  updatedAt: number
  running: boolean
  state: Orchestrator['state']
  messages: Awaited<ReturnType<typeof loadMessages>>
}> {
  const [detail, info] = await Promise.all([
    loadSession(sessionId) as Promise<{
      id: string
      title?: string
      running: boolean
      state: Orchestrator['state']
      messages: Awaited<ReturnType<typeof loadMessages>>
    }>,
    stat(resolve(stateDir, sessionId)),
  ])

  return {
    ...detail,
    updatedAt: info.mtimeMs,
  }
}

export async function updateSessionTitle(sessionId: string, title: string): Promise<unknown> {
  const nextTitle = title.trim()
  await saveSessionMeta(sessionId, nextTitle ? { title: nextTitle } : {})
  return loadSession(sessionId)
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

export async function updateRepositoryConfig(sessionId: string, config: unknown): Promise<unknown> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('repository 配置必须是对象')
  }
  const orchestrator = await getOrchestrator(sessionId)
  await orchestrator.setRepositoryConfig(normalizeRepositoryConfig(config as Partial<RepositoryConfig>))
  return loadSession(sessionId)
}

export async function addMemoryItem(sessionId: string, body: Record<string, unknown>): Promise<unknown> {
  const content = typeof body.body === 'string' ? body.body.trim() : ''
  const description = typeof body.description === 'string' ? body.description.trim() : content
  const name = typeof body.name === 'string' ? body.name.trim() : undefined
  const type = isMemoryType(body.type) ? body.type : 'project'
  const layer = body.layer ?? 'project'
  if (!isMemoryLayerId(layer)) {
    throw new Error('layer 必须是 session、project 或 global')
  }
  if (!content) throw new Error('body 不能为空')
  const orchestrator = await getOrchestrator(sessionId)
  const result = await orchestrator.saveMemoryItem({ layer, name, description, type, body: content })
  return {
    ...result,
    memoryState: await orchestrator.getMemoryState(),
  }
}

export async function removeMemoryItem(sessionId: string, name: string): Promise<unknown> {
  const orchestrator = await getOrchestrator(sessionId)
  const { deleted } = await orchestrator.forgetMemory(name)
  return {
    deleted,
    memoryState: await orchestrator.getMemoryState(),
  }
}

export async function revealMemoryItem(sessionId: string, layer: unknown, name: string): Promise<unknown> {
  if (!isMemoryLayerId(layer)) {
    throw new Error('layer 必须是 session、project 或 global')
  }
  const orchestrator = await getOrchestrator(sessionId)
  const memoryState = await orchestrator.getMemoryState()
  const item = memoryState.layers
    .find((memoryLayer) => memoryLayer.id === layer)
    ?.items.find((memoryItem) => memoryItem.name === name)
  if (!item) throw new Error(`记忆不存在: ${name}`)
  await revealPath(item.filePath)
  return { ok: true, filePath: item.filePath }
}

export async function abortSession(sessionId: string): Promise<void> {
  const orchestrator = await getOrchestrator(sessionId)
  orchestrator.abort()
}

export async function deleteSession(sessionId: string): Promise<void> {
  activeRuns.delete(sessionId)
  orchestrators.delete(sessionId)
  await rm(resolve(stateDir, sessionId), { recursive: true, force: true })
}
