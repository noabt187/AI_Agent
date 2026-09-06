import { access } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { runCommand } from '../utils/command.js'
import type { AgentEventHandler, ConfirmationRef, TaskRequestBinding, TurnContext, WorldState } from './types.js'
import { sessionRunStore, type RunRecord, type RunStatus } from '../state/runStore.js'
import { Agent } from './agent.js'
import { bindTaskInput, TaskStateError, workspaceKey } from './taskInput.js'
import { applyTaskResult, beginTaskTurn, invalidateTaskWorkspace, ownsTurn, pauseTask, projectTask, requireConfirmation } from './taskState.js'
import { normalizeTaskState, reconcileTaskRuns } from './taskPersistence.js'
import { legacyAgentRuntime, type AgentRuntime } from './runtime.js'
import { maybeCompressContext } from '../context/contextCompressor.js'
import { loadOrchestratorState, saveOrchestratorState } from '../state/sessionStore.js'
import { createMetricRecorder, formatStats } from '../context/monitor.js'
import {
  deleteMemoryByName,
  isMemoryLayerId,
  listMemoryLayers,
  MEMORY_LAYER_LABELS,
  saveMemory,
  type MemoryLayerId,
  type MemoryLayersState,
  type MemoryType,
  type MemoryItem,
} from '../memory/projectMemory.js'
import {
  isMemoryRecallMode,
  normalizeMemorySettings,
  normalizeRepositoryConfig,
  type MemoryRecallMode,
  type MemorySettings,
  type RepositoryConfig,
} from './types.js'

type AskConfirmFn = (question: string) => Promise<boolean>
type AskInputFn = (question: string) => Promise<string>

export class Orchestrator {
  state: WorldState
  private askConfirm?: AskConfirmFn
  private askInput?: AskInputFn
  private agent: Pick<Agent, 'run'>
  private executing = false
  private abortController?: AbortController
  private externalSignal?: AbortSignal
  private userMessageId?: string
  private metricRecorder: (metric: import('../llm/monitoredClient.js').LlmCallMetric) => void

  constructor(sessionId: string, initialState?: WorldState, runtime: AgentRuntime = legacyAgentRuntime, runner?: Pick<Agent, 'run'>) {
    this.state = normalizeTaskState(initialState ?? {
      sessionId,
      allowedPaths: [],
      memorySettings: normalizeMemorySettings(),
      completedTaskIds: [],
      failedTaskIds: [],
    })
    this.state.memorySettings = normalizeMemorySettings(this.state.memorySettings)
    this.state.repository = normalizeRepositoryConfig(this.state.repository)
    this.agent = runner ?? new Agent(runtime)
    this.metricRecorder = createMetricRecorder(this.state.sessionId)
  }

  static async load(sessionId: string, runtime: AgentRuntime = legacyAgentRuntime): Promise<Orchestrator> {
    const persisted = await loadOrchestratorState<WorldState>(sessionId)
    if (persisted) {
      persisted.allowedPaths = persisted.allowedPaths || []
      persisted.completedTaskIds = persisted.completedTaskIds || []
      persisted.failedTaskIds = persisted.failedTaskIds || []
      persisted.memorySettings = normalizeMemorySettings(persisted.memorySettings)
      persisted.repository = normalizeRepositoryConfig(persisted.repository)
    }
    const orchestrator = new Orchestrator(sessionId, persisted ?? {
      sessionId,
      allowedPaths: [],
      memorySettings: normalizeMemorySettings(),
      repository: normalizeRepositoryConfig(),
      completedTaskIds: [],
      failedTaskIds: [],
    }, runtime)
    await orchestrator.reconcileRuns(await sessionRunStore.list(sessionId))
    return orchestrator
  }

  setAskConfirm(fn: AskConfirmFn) { this.askConfirm = fn }
  setAskInput(fn: AskInputFn) { this.askInput = fn }

  private async emitOutput(message: string, onEvent?: AgentEventHandler) {
    this.externalSignal?.throwIfAborted()
    console.log(message)
    await onEvent?.({ type: 'output', message })
    this.externalSignal?.throwIfAborted()
  }

  abort() {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = undefined
    }
  }

  async persist(): Promise<void> {
    await saveOrchestratorState(this.state.sessionId, this.state)
  }

  private getProjectDir(): string {
    return this.state.allowedPaths[0] ?? process.cwd()
  }

  async getMemoryState(): Promise<{ settings: MemorySettings } & MemoryLayersState> {
    this.state.memorySettings = normalizeMemorySettings(this.state.memorySettings)
    const memory = await listMemoryLayers(this.getProjectDir(), this.state.sessionId)
    return {
      settings: this.state.memorySettings,
      ...memory,
    }
  }

  async setMemoryRecallMode(mode: MemoryRecallMode): Promise<void> {
    this.externalSignal?.throwIfAborted()
    this.state.memorySettings = { recallMode: mode }
    await this.persist()
  }

  async setRepositoryConfig(config: Partial<RepositoryConfig>): Promise<void> {
    if (this.executing) throw new TaskStateError('busy', '运行期间不能更换仓库')
    const previous = workspaceKey(this.state)
    this.state.repository = normalizeRepositoryConfig(config)
    if (workspaceKey(this.state) !== previous) invalidateTaskWorkspace(this.state)
    await this.persist()
  }

  async setAllowedPaths(paths: string[]): Promise<void> {
    if (this.executing) throw new TaskStateError('busy', '运行期间不能更换目录')
    if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !p.trim())) throw new TaskStateError('malformed_paths', '无效操作目录', 400)
    const previous = workspaceKey(this.state)
    this.state.allowedPaths = [...paths]
    if (workspaceKey(this.state) !== previous) invalidateTaskWorkspace(this.state)
    await this.persist()
  }

  bindInput(input: string, control?: unknown, ids?: { runId: string; userMessageId: string }): TaskRequestBinding {
    return bindTaskInput(this.state, input, control, ids)
  }

  async clearConfirmation(expected: ConfirmationRef): Promise<void> {
    if (this.executing) throw new TaskStateError('busy', '运行期间不能撤销确认')
    requireConfirmation(this.state, expected)
    this.state.task!.pendingConfirmation = undefined
    this.state.task!.approval = undefined
    this.state.task!.phase = 'paused'
    projectTask(this.state)
    await this.persist()
  }

  async reconcileRuns(records: RunRecord[]): Promise<void> {
    if (this.executing) throw new TaskStateError('busy', '运行期间不能恢复状态')
    if (reconcileTaskRuns(this.state, records)) await this.persist()
  }

  async finalizeCancelledRun(runId: string, onEvent?: AgentEventHandler): Promise<void> {
    const task = this.state.task
    if (!task || task.lastRunId !== runId || task.phase === 'cancelled') return
    // Queue finalization still owns this run, including the gap after Agent return.
    task.phase = 'paused'; task.interruption = 'cancelled'; projectTask(this.state)
    await this.persist()
    if (this.state.task === task && task.lastRunId === runId) {
      await onEvent?.({ type: 'task', runId, task: structuredClone(task) })
    }
  }

  async rememberMemory(layer: MemoryLayerId, content: string): Promise<{ memory: MemoryItem; created: boolean }> {
    return this.saveMemoryItem({
      layer,
      description: content,
      body: content,
      type: 'project',
    })
  }

  async saveMemoryItem(input: {
    layer: MemoryLayerId
    name?: string
    description: string
    type?: MemoryType
    body: string
  }): Promise<{ memory: MemoryItem; created: boolean }> {
    this.externalSignal?.throwIfAborted()
    return saveMemory({
      ...input,
      projectDir: this.getProjectDir(),
      sessionId: this.state.sessionId,
    })
  }

  async forgetMemory(id: string): Promise<{ deleted: boolean; layer?: MemoryLayerId }> {
    this.externalSignal?.throwIfAborted()
    return deleteMemoryByName(this.getProjectDir(), this.state.sessionId, id)
  }

  private async ensureAllowedPaths(onEvent?: AgentEventHandler) {
    if (!this.state.allowedPaths || this.state.allowedPaths.length === 0) {
      const previousWorkspace = workspaceKey(this.state)
      const defaultPath = process.cwd()
      await this.emitOutput('\n[设置操作目录] Agent 可在以下目录中读写文件：', onEvent)
      await this.emitOutput(`  默认: ${defaultPath}`, onEvent)

      if (this.askInput) {
        const input = await this.askInput('请输入操作目录（直接回车使用默认，多个目录用逗号分隔）：')
        this.externalSignal?.throwIfAborted()
        if (input.trim()) {
          this.state.allowedPaths = input.split(',').map((p) => p.trim()).filter(Boolean)
        } else {
          this.state.allowedPaths = [defaultPath]
        }
      } else {
        this.state.allowedPaths = [defaultPath]
      }

      if (workspaceKey(this.state) !== previousWorkspace) invalidateTaskWorkspace(this.state)

      await this.emitOutput(`[操作目录已设置] ${this.state.allowedPaths.join(', ')}`, onEvent)
      await this.persist()
    }
  }

  async handleUserInput(userInput: string, onEvent?: AgentEventHandler, signal?: AbortSignal, userMessageId?: string, binding?: TaskRequestBinding): Promise<void> {
    if (this.executing) throw new TaskStateError('busy', '当前会话正在运行')
    let bound = binding ?? this.bindInput(userInput, undefined, userMessageId ? { runId: randomUUID(), userMessageId } : undefined)
    const needsDirectory = this.state.allowedPaths.length === 0
    if (bound.input !== userInput || (userMessageId && bound.userMessageId !== userMessageId)) throw new TaskStateError('malformed_binding', '请求绑定不一致', 400)
    this.executing = true
    this.externalSignal = signal
    this.userMessageId = bound.userMessageId
    let localRun: RunRecord | undefined
    const outcome: { status: RunStatus } = { status: 'completed' }
    let failure: unknown
    const deliver: AgentEventHandler = async event => {
      if (localRun) {
        if (event.type === 'aborted') outcome.status = 'cancelled'
        if (event.type === 'error' && !event.recoverable) outcome.status = 'failed'
        if (event.type === 'task' && event.runId === localRun.id && event.task.lastRunId === localRun.id) {
          await sessionRunStore.update(this.state.sessionId, localRun.id, { taskId: event.task.id, taskRevision: event.task.revision, taskPhase: event.task.phase })
        }
      }
      await onEvent?.(event)
    }
    try {
      signal?.throwIfAborted()
      // Unbound calls are CLI/direct turns; HTTP admission already owns its row.
      if (!binding) {
        localRun = await sessionRunStore.create(this.state.sessionId, userInput, bound)
        await sessionRunStore.update(this.state.sessionId, localRun.id, { status: 'running', binding: bound })
      }
      await this.ensureAllowedPaths(deliver)
      // An interactive CLI request binds to the directory just chosen by its user.
      // An already admitted queue binding must keep its captured target.
      if (!binding && needsDirectory) bound = this.bindInput(userInput, bound.control, { runId: bound.runId, userMessageId: bound.userMessageId })
      if (localRun) await sessionRunStore.update(this.state.sessionId, localRun.id, { binding: bound })
      await this.handleInput(userInput, deliver, bound)
      signal?.throwIfAborted()
    } catch (error) {
      failure = error
      if (outcome.status !== 'cancelled') outcome.status = signal?.aborted ? 'cancelled' : 'failed'
      throw error
    } finally {
      try {
        if (localRun) {
          if (signal?.aborted) outcome.status = 'cancelled'
          if (outcome.status === 'cancelled') await this.finalizeCancelledRun(localRun.id, deliver)
          await sessionRunStore.update(this.state.sessionId, localRun.id, { status: outcome.status, error: failure instanceof Error ? failure.message : failure === undefined ? undefined : String(failure) })
        }
      } finally { this.externalSignal = undefined; this.userMessageId = undefined; this.executing = false }
    }
  }

  private async handleInput(userInput: string, onEvent: AgentEventHandler | undefined, binding: TaskRequestBinding): Promise<void> {
    this.externalSignal?.throwIfAborted()

    if (userInput === '设置目录') {
      await this.handleSetDirectory(onEvent)
      return
    }
    if (userInput.startsWith('/revert')) {
      await this.handleRevert(userInput, onEvent)
      return
    }
    if (userInput === '/stats') {
      const report = await formatStats(this.state.sessionId)
      console.log(`\n${report}`)
      return
    }
    if (userInput === '/memory' || userInput.startsWith('/memory ')) {
      await this.handleMemoryCommand(userInput, onEvent)
      return
    }
    if (userInput.startsWith('/remember')) {
      await this.handleRememberCommand(userInput, onEvent)
      return
    }

    const turn = beginTaskTurn(this.state, binding)
    await this.runAgentTurn(userInput, onEvent, turn)
  }

  private async runAgentTurn(userInput: string, onEvent: AgentEventHandler | undefined, turn: TurnContext): Promise<void> {
    const controller = new AbortController()
    this.abortController = controller
    const signal = this.externalSignal ? AbortSignal.any([controller.signal, this.externalSignal]) : controller.signal
    let acceptingEvents = true
    const emitTask = async () => { if (ownsTurn(this.state, turn)) await onEvent?.({ type: 'task', runId: turn.runId, task: structuredClone(this.state.task!) }) }
    const ownedEvent: AgentEventHandler = async event => { if (acceptingEvents && ownsTurn(this.state, turn) && !signal.aborted) await onEvent?.(event) }
    try {
      await this.persist()
      await emitTask()
      signal.throwIfAborted()
      if (turn.intent === 'cancel') {
        await this.emitOutput('\n[已取消] 当前任务已取消，历史和已执行结果保留。', ownedEvent)
        return
      }
      if (this.state.task?.phase === 'awaiting_confirmation') {
        await this.emitOutput(this.state.task.pendingConfirmation!.prompt, ownedEvent)
        return
      }
      try {
        const compressed = await maybeCompressContext(this.state.sessionId, undefined, undefined, signal)
        signal.throwIfAborted()
        if (compressed) await this.emitOutput('[上下文压缩] 消息过长，已压缩旧对话并保留最近 10 轮', ownedEvent)
      } catch (error) {
        signal.throwIfAborted()
        await ownedEvent({ type: 'error', message: error instanceof Error ? error.message : String(error), recoverable: true })
      }
      const result = await this.agent.run(this.state.sessionId, userInput, this.state, signal, ownedEvent, this.metricRecorder, this.userMessageId, turn)
      signal.throwIfAborted()
      if (!ownsTurn(this.state, turn)) return
      await ownedEvent({ type: 'result', result })
      signal.throwIfAborted()
      if (applyTaskResult(this.state, turn, result)) await this.handleAgentResult(result, ownedEvent)
      signal.throwIfAborted()
    } catch (error) {
      pauseTask(this.state, turn, signal.aborted ? 'cancelled' : 'error')
      if (signal.aborted) await onEvent?.({ type: 'aborted', message: '中断完成' })
      throw error
    } finally {
      acceptingEvents = false
      // Host finalization must persist even when execution has been cancelled.
      if (signal.aborted) pauseTask(this.state, turn, 'cancelled')
      try {
        await this.persist()
        await emitTask()
      } finally {
        // Cancellation may arrive while awaiting terminal delivery/persistence.
        if (signal.aborted && ownsTurn(this.state, turn) && this.state.task?.phase !== 'paused' && this.state.task?.phase !== 'cancelled') {
          pauseTask(this.state, turn, 'cancelled')
          await this.persist()
          await emitTask()
        }
        if (this.abortController === controller) this.abortController = undefined
      }
    }
  }

  private async handleAgentResult(result: import('./types.js').AgentResult, onEvent?: AgentEventHandler) {
    switch (result.action) {
      case 'chat':
        await this.emitOutput(result.message, onEvent)
        break
      case 'ask_user':
        if (result.message) await this.emitOutput(`\n${result.message}`, onEvent)
        await this.emitOutput('\n[需要你确认]', onEvent)
        for (const [i, q] of result.questions.entries()) {
          console.log(`  ${i + 1}. ${q}`)
          await onEvent?.({ type: 'output', message: `  ${i + 1}. ${q}` })
        }
        break
      case 'confirm':
        if (result.message) await this.emitOutput(`\n${result.message}`, onEvent)
        await this.emitOutput(`\n${result.prompt}`, onEvent)
        const allowWrite = result.confirmType === 'allow_write'
        if (allowWrite) {
          await this.emitOutput('\n⚠️ 确认此方案后，Agent 将获得文件写入和副作用操作权限，请仔细核对方案内容。', onEvent)
        }
        break
      case 'done':
        await this.emitOutput(`\n${result.message}`, onEvent)
        break
    }
  }

  private async handleSetDirectory(onEvent?: AgentEventHandler) {
    if (this.askInput) {
      await this.emitOutput(`\n当前操作目录: ${this.state.allowedPaths.join(', ')}`, onEvent)
      const input = await this.askInput('请输入新的操作目录（多个目录用逗号分隔）：')
      this.externalSignal?.throwIfAborted()
      if (input.trim()) {
        this.state.allowedPaths = input.split(',').map((p) => p.trim()).filter(Boolean)
        invalidateTaskWorkspace(this.state)
        await this.persist()
        await this.emitOutput(`[操作目录已更新] ${this.state.allowedPaths.join(', ')}`, onEvent)
      }
    }
  }

  private async emitMemoryStatus(onEvent?: AgentEventHandler) {
    const memory = await this.getMemoryState()
    const total = memory.layers.reduce((sum, layer) => sum + layer.items.length, 0)
    await this.emitOutput(`\n[memory] 召回模式: ${memory.settings.recallMode}`, onEvent)
    await this.emitOutput(`[memory] Markdown 记忆: ${total} 条（会话/项目/全局）`, onEvent)
  }

  private async handleMemoryCommand(input: string, onEvent?: AgentEventHandler) {
    const parts = input.trim().split(/\s+/)
    const action = parts[1]

    if (!action) {
      await this.emitMemoryStatus(onEvent)
      await this.emitOutput('[memory] 用法: /memory auto|off|on|list|forget <id>', onEvent)
      return
    }

    if (isMemoryRecallMode(action)) {
      await this.setMemoryRecallMode(action)
      await this.emitOutput(`\n[memory] 召回模式已设置为 ${action}`, onEvent)
      return
    }

    if (action === 'list') {
      const { layers } = await this.getMemoryState()
      await this.emitOutput('\n[memory] Markdown 记忆:', onEvent)
      for (const layer of layers) {
        await this.emitOutput(`  ${layer.label}: ${layer.items.length} 条`, onEvent)
        await this.emitOutput(`    索引: ${layer.paths.index}`, onEvent)
        for (const item of layer.items) {
          await this.emitOutput(`    ${item.name} [${item.type}] - ${item.description}`, onEvent)
        }
      }
      return
    }

    if (action === 'forget') {
      const id = parts[2]
      if (!id) {
        await this.emitOutput('\n[memory] 用法: /memory forget <id>', onEvent)
        return
      }
      const result = await this.forgetMemory(id)
      await this.emitOutput(
        result.deleted
          ? `\n[memory] 已删除${result.layer ? MEMORY_LAYER_LABELS[result.layer] : ''}: ${id}`
          : `\n[memory] 未找到记忆: ${id}`,
        onEvent,
      )
      return
    }

    await this.emitOutput('\n[memory] 未识别的命令。用法: /memory auto|off|on|list|forget <id>', onEvent)
  }

  private async handleRememberCommand(input: string, onEvent?: AgentEventHandler) {
    const raw = input.replace(/^\/remember\b/, '').trim()
    const [first, ...rest] = raw.split(/\s+/)
    const layer = isMemoryLayerId(first) ? first : 'project'
    const content = isMemoryLayerId(first) ? rest.join(' ').trim() : raw
    if (!content) {
      await this.emitOutput('\n[remember] 用法: /remember [session|project|global] <需要长期记住的内容>', onEvent)
      return
    }

    try {
      const { memory, created } = await this.rememberMemory(layer, content)
      await this.emitOutput(
        created
          ? `\n[remember] 已保存${MEMORY_LAYER_LABELS[layer]}: ${memory.id}`
          : `\n[remember] 已存在相同${MEMORY_LAYER_LABELS[layer]}: ${memory.id}`,
        onEvent,
      )
    } catch (err) {
      await onEvent?.({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  private async handleRevert(input: string, onEvent?: AgentEventHandler) {
    const parts = input.split(/\s+/)
    if (parts.length < 3) {
      await this.emitOutput('\n[用法] /revert <项目路径> <GitHub仓库地址>', onEvent)
      await this.emitOutput('[示例] /revert D:\\my_test\\conduit-realworld-example-app https://github.com/xxx/xxx.git', onEvent)
      return
    }

    const projectPath = parts[1]
    const githubRepoUrl = parts[2]

    try {
      await access(projectPath)
    } catch {
      await this.emitOutput(`\n[错误] 目录不存在: ${projectPath}`, onEvent)
      return
    }

    try {
      await access(`${projectPath}/.git`)
    } catch {
      await this.emitOutput(`\n[错误] 该目录不是 git 仓库: ${projectPath}`, onEvent)
      return
    }

    try {
      await this.emitOutput('\n[revert] 正在拉取远程最新版本...', onEvent)
      await runCommand('git', ['fetch', '--', githubRepoUrl], projectPath, 120000, this.externalSignal)

      const { stdout: diffOutput } = await runCommand('git', ['diff', 'HEAD'], projectPath, 120000, this.externalSignal)
      if (!diffOutput.trim()) {
        await this.emitOutput('[revert] 没有检测到本地改动，无需回退。', onEvent)
        return
      }

      const diffLines = diffOutput.split('\n')
      const truncated = diffLines.length > 200
      const displayDiff = truncated ? diffLines.slice(0, 200).join('\n') : diffOutput

      await this.emitOutput('\n[revert] 本地改动如下：', onEvent)
      await this.emitOutput(displayDiff, onEvent)
      if (truncated) {
        await this.emitOutput(`\n... 共 ${diffLines.length} 行，已截断`, onEvent)
      }

      if (this.askConfirm) {
        const confirmed = await this.askConfirm('\n确认丢弃以上所有改动？')
        this.externalSignal?.throwIfAborted()
        if (!confirmed) {
          await this.emitOutput('[revert] 已取消。', onEvent)
          return
        }
      }

      this.externalSignal?.throwIfAborted()
      await runCommand('git', ['checkout', '--', '.'], projectPath, 120000, this.externalSignal)
      await this.emitOutput('[revert] 已回退到 GitHub 最新版本。', onEvent)
    } catch (err) {
      console.error('[revert] 执行失败:', err instanceof Error ? err.message : err)
      await onEvent?.({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

}
