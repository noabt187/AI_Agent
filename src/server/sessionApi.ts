import { execFile, spawn } from 'node:child_process'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Orchestrator } from '../orchestrator/orchestrator.js'
import { legacyAgentRuntime, type AgentRuntime } from '../orchestrator/runtime.js'
import { SessionPromptQueue, type PromptJob } from './promptQueue.js'
import { loadMessages, loadSessionMeta, saveSessionMeta } from '../state/sessionStore.js'
import { sessionRunStore as runStore, isTerminalRun, type RunStatus } from '../state/runStore.js'
import { isMemoryRecallMode, normalizeRepositoryConfig, type MemoryRecallMode, type RepositoryConfig } from '../orchestrator/types.js'
import { isMemoryLayerId, isMemoryType } from '../memory/projectMemory.js'
import { beginTaskTurn } from '../orchestrator/taskState.js'
import type { ConfirmationRef, TaskRequestBinding } from '../orchestrator/types.js'
import { TaskStateError } from '../orchestrator/taskInput.js'

const stateDir = resolve(process.cwd(), 'state')
const orchestrators = new Map<string, Orchestrator>()
const loadingOrchestrators = new Map<string, Promise<Orchestrator>>()
const liveCreatedAt = new Map<string, number>()
const activeRuns = new Set<string>()
const execFileAsync = promisify(execFile)
let agentRuntime: AgentRuntime = legacyAgentRuntime
let promptQueue = createSessionPromptQueue()

export type LiveSessionEvent = {
  type: 'loaded'
  sessionId: string
  orchestrator: Orchestrator
  createdAt: number
} | {
  type: 'deleted'
  sessionId: string
}

const liveSessionListeners = new Set<(event: LiveSessionEvent) => void>()

export function observeLiveSessions(listener: (event: LiveSessionEvent) => void): () => void {
  liveSessionListeners.add(listener)
  for (const [sessionId, orchestrator] of orchestrators) {
    listener({
      type: 'loaded',
      sessionId,
      orchestrator,
      createdAt: liveCreatedAt.get(sessionId) ?? Date.now(),
    })
  }
  return () => { liveSessionListeners.delete(listener) }
}

export function peekOrchestrator(sessionId: string): Orchestrator | undefined {
  return orchestrators.get(sessionId)
}

export function createSessionPromptQueue(): SessionPromptQueue {
  return new SessionPromptQueue(
    async (job: PromptJob) => {
      const orchestrator = await getOrchestrator(job.sessionId)
      markSessionRunning(job.sessionId)
      try {
        await orchestrator.handleUserInput(job.prompt, job.onEvent, job.signal, job.userMessageId, job.binding)
      } finally {
        markSessionIdle(job.sessionId)
      }
    },
    sessionId => { orchestrators.get(sessionId)?.abort() },
  )
}

export function configureSessionRuntime(runtime: AgentRuntime, queue: SessionPromptQueue): () => void {
  const previousRuntime = agentRuntime
  const previousQueue = promptQueue
  agentRuntime = runtime
  promptQueue = queue
  let configured = true
  return () => {
    if (!configured) return
    configured = false
    agentRuntime = previousRuntime
    promptQueue = previousQueue
  }
}

export async function enqueueSessionPrompt(job: PromptJob): Promise<void> {
  if (job.origin !== undefined && job.origin !== 'composer' && job.origin !== 'plugin') throw new TaskStateError('malformed_origin', '无效请求来源', 400)
  const orchestrator = await getOrchestrator(job.sessionId)
  // Capture intent, proposal identity and workspace before the first admission I/O.
  const binding = orchestrator.bindInput(job.prompt, job.control)
  if (binding.control) beginTaskTurn(structuredClone(orchestrator.state), binding)
  await validateFollowup(job.sessionId, binding)
  const record = await runStore.create(job.sessionId, job.prompt, binding)
  try {
    await runStore.update(job.sessionId, record.id, { binding, origin: job.origin })
  } catch (error) {
    await runStore.update(job.sessionId, record.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
    throw error
  }
  // Delivery failure is not an execution failure: reconnecting clients recover
  // durable state through the session endpoint.
  const deliver: PromptJob['onEvent'] = async event => { try { await job.onEvent(event) } catch {} }
  const emitRecord = async () => {
    const runs = await runStore.list(job.sessionId)
    await deliver({ type: 'run', run: runs.find(item => item.id === record.id)! })
  }
  let before: Set<string> | undefined
  let outcome: RunStatus = 'completed'
  let errorMessage: string | undefined
  let partial = ''
  let previousPartial = ''
  let lastSaved = 0
  let finished = false
  const currentMessageIds = async () => before
    ? (await loadMessages(job.sessionId)).filter(message => !before!.has(message.uuid)).map(message => message.uuid)
    : []
  const finish = async (error: unknown, signal?: AbortSignal) => {
    if (finished) return
    if (signal?.aborted) {
      outcome = 'cancelled'
      await orchestrator.finalizeCancelledRun(record.id, originalExecute)
    }
    else if (error !== undefined) outcome = 'failed'
    if (error !== undefined) errorMessage = error instanceof Error ? error.message : String(error)
    await runStore.update(job.sessionId, record.id, {
      status: outcome,
      messageIds: await currentMessageIds(),
      partialOutput: outcome === 'completed' ? undefined : partial || previousPartial,
      error: errorMessage,
    })
    finished = true
    await emitRecord()
  }
  const originalExecute = async (event: Parameters<PromptJob['onEvent']>[0]) => {
    if (finished) return
    if (event.type === 'task') {
      if (event.runId !== record.id || event.task.lastRunId !== record.id) return
      await runStore.update(job.sessionId, record.id, { taskId: event.task.id, taskRevision: event.task.revision, taskPhase: event.task.phase })
    }
    if (event.type === 'aborted') outcome = 'cancelled'
    if (event.type === 'result') {
      await runStore.update(job.sessionId, record.id, { resultMeta: {
        action: event.result.action,
        ...(event.result.action === 'chat' && event.result.protocolFallback ? { protocolFallback: true as const } : {}),
      } })
    }
    if (event.type === 'error' && !event.recoverable) { outcome = 'failed'; errorMessage = event.message }
    if (event.type === 'tool_call') { if (partial.trim()) previousPartial = partial; partial = '' }
    if (event.type === 'delta') {
      partial += event.text
      if (Date.now() - lastSaved > 1000) {
        await runStore.update(job.sessionId, record.id, { partialOutput: partial, messageIds: await currentMessageIds() })
        lastSaved = Date.now()
      }
    }
    if (event.type === 'output' || event.type === 'tool_call' || event.type === 'result') {
      if (event.type === 'output') partial = ''
      await runStore.update(job.sessionId, record.id, { partialOutput: partial || previousPartial, messageIds: await currentMessageIds() })
    }
    await deliver(event)
  }
  try {
    await job.onAccepted?.()
    await emitRecord()
    await promptQueue.enqueue({
      ...job,
      binding,
      userMessageId: record.userMessageId,
      onStart: async () => {
        await validateFollowup(job.sessionId, binding)
        before = new Set((await loadMessages(job.sessionId)).map(message => message.uuid))
        await runStore.update(job.sessionId, record.id, { status: 'running' })
        await emitRecord()
        await job.onStart?.()
      },
      onEvent: originalExecute,
      onFinish: finish,
    })
  } catch (error) {
    await finish(error, job.signal)
    throw error
  }
}

async function validateFollowup(sessionId: string, binding: TaskRequestBinding): Promise<void> {
  const c = binding.control
  if (c?.kind !== 'followup') return
  const runs = await runStore.list(sessionId)
  const source = runs.find(run => run.id === c.sourceRunId && run.sessionId === sessionId)
  if (!source || !isTerminalRun(source.status) || source.taskId !== c.taskId || source.taskRevision !== c.taskRevision
    || (source.binding && source.binding.workspaceKey !== binding.workspaceKey)
    || runs.some(run => run.id !== binding.runId && run.status === 'running')) {
    throw new TaskStateError('stale_followup', '来源运行未结束或已改变，请重新查看当前任务')
  }
  // Recheck state after the asynchronous read, at admission AND actual dequeue.
  const orchestrator = await getOrchestrator(sessionId)
  beginTaskTurn(structuredClone(orchestrator.state), binding)
}

async function readCommandValue(cwd: string, file: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync(file, args, {
      cwd,
      timeout: 8000,
      maxBuffer: 128 * 1024,
    })
    const value = (result.stdout ?? '').trim()
    return value || undefined
  } catch {
    return undefined
  }
}

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
      liveCreatedAt.delete(sessionId)
      emitLiveSession({ type: 'deleted', sessionId })
    }
    if (orchestrators.has(sessionId)) return existing
  }

  const loading = loadingOrchestrators.get(sessionId)
  if (loading) return loading
  const task = loadOrchestrator(sessionId)
  loadingOrchestrators.set(sessionId, task)
  try { return await task } finally { loadingOrchestrators.delete(sessionId) }
}

async function loadOrchestrator(sessionId: string): Promise<Orchestrator> {
  const orchestrator = await Orchestrator.load(sessionId, agentRuntime)
  orchestrators.set(sessionId, orchestrator)
  let createdAt = Date.now()
  try {
    const info = await stat(resolve(stateDir, sessionId))
    createdAt = info.birthtimeMs || info.ctimeMs || info.mtimeMs
  } catch {}
  liveCreatedAt.set(sessionId, createdAt)
  emitLiveSession({ type: 'loaded', sessionId, orchestrator, createdAt })
  return orchestrator
}

export function isSessionRunning(sessionId: string): boolean {
  return activeRuns.has(sessionId) || promptQueue.isRunning(sessionId)
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
  const meta = await loadSessionMeta(sessionId)
  // A terminal record must never be paired with messages read before it finished.
  // Bound retries during active writes and ask the client to poll again if busy.
  let runs = await runStore.list(sessionId)
  let messages: Awaited<ReturnType<typeof loadMessages>> = []
  let stable = false
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = JSON.stringify(runs)
    messages = await loadMessages(sessionId)
    runs = await runStore.list(sessionId)
    if (before === JSON.stringify(runs)) { stable = true; break }
  }
  return {
    id: sessionId,
    title: meta.title,
    running: !stable || isSessionRunning(sessionId) || runs.some(run => run.status === 'queued' || run.status === 'running'),
    state: orchestrator.state,
    messages,
    runs,
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
  for (const path of allowedPaths) {
    if (!isAbsolute(path) || !(await stat(path)).isDirectory()) throw new Error('操作目录必须是存在的绝对目录路径')
  }
  const orchestrator = await getOrchestrator(sessionId)
  await orchestrator.setAllowedPaths(allowedPaths)
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

export async function loadRepositoryIdentity(sessionId: string): Promise<unknown> {
  const orchestrator = await getOrchestrator(sessionId)
  const rootDir = orchestrator.state.allowedPaths[0] || process.cwd()
  const [githubLogin, gitUserName, gitUserEmail] = await Promise.all([
    readCommandValue(rootDir, 'gh', ['api', 'user', '--jq', '.login']),
    readCommandValue(rootDir, 'git', ['config', 'user.name']),
    readCommandValue(rootDir, 'git', ['config', 'user.email']),
  ])

  return {
    rootDir,
    githubLogin,
    gitUserName,
    gitUserEmail,
  }
}

export async function clearPendingConfirm(sessionId: string, expected: ConfirmationRef): Promise<unknown> {
  const orchestrator = await getOrchestrator(sessionId)
  await orchestrator.clearConfirmation(expected)
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

export async function abortSession(sessionId: string, expectedRunId?: string): Promise<void> {
  await promptQueue.abort(sessionId, expectedRunId)
}

export async function deleteSession(sessionId: string): Promise<void> {
  await promptQueue.delete(sessionId)
  activeRuns.delete(sessionId)
  orchestrators.delete(sessionId)
  liveCreatedAt.delete(sessionId)
  emitLiveSession({ type: 'deleted', sessionId })
  await rm(resolve(stateDir, sessionId), { recursive: true, force: true })
}

function emitLiveSession(event: LiveSessionEvent): void {
  for (const listener of liveSessionListeners) listener(event)
}
