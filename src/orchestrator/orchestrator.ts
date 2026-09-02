import { exec } from 'node:child_process'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { AgentEventHandler, WorldState } from './types.js'
import { Agent, isPureConfirmationInput } from './agent.js'
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

const execAsync = promisify(exec)

type AskConfirmFn = (question: string) => Promise<boolean>
type AskInputFn = (question: string) => Promise<string>

export class Orchestrator {
  state: WorldState
  private askConfirm?: AskConfirmFn
  private askInput?: AskInputFn
  private agent: Agent
  private abortController?: AbortController
  private metricRecorder: (metric: import('../llm/monitoredClient.js').LlmCallMetric) => void

  constructor(sessionId: string, initialState?: WorldState, runtime: AgentRuntime = legacyAgentRuntime) {
    this.state = initialState ?? {
      sessionId,
      allowedPaths: [],
      memorySettings: normalizeMemorySettings(),
      completedTaskIds: [],
      failedTaskIds: [],
    }
    this.state.memorySettings = normalizeMemorySettings(this.state.memorySettings)
    this.state.repository = normalizeRepositoryConfig(this.state.repository)
    this.agent = new Agent(runtime)
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
    return new Orchestrator(sessionId, persisted ?? {
      sessionId,
      allowedPaths: [],
      memorySettings: normalizeMemorySettings(),
      repository: normalizeRepositoryConfig(),
      completedTaskIds: [],
      failedTaskIds: [],
    }, runtime)
  }

  setAskConfirm(fn: AskConfirmFn) { this.askConfirm = fn }
  setAskInput(fn: AskInputFn) { this.askInput = fn }

  private async emitOutput(message: string, onEvent?: AgentEventHandler) {
    console.log(message)
    await onEvent?.({ type: 'output', message })
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
    this.state.memorySettings = { recallMode: mode }
    await this.persist()
  }

  async setRepositoryConfig(config: Partial<RepositoryConfig>): Promise<void> {
    this.state.repository = normalizeRepositoryConfig(config)
    await this.persist()
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
    return saveMemory({
      ...input,
      projectDir: this.getProjectDir(),
      sessionId: this.state.sessionId,
    })
  }

  async forgetMemory(id: string): Promise<{ deleted: boolean; layer?: MemoryLayerId }> {
    return deleteMemoryByName(this.getProjectDir(), this.state.sessionId, id)
  }

  private async ensureAllowedPaths(onEvent?: AgentEventHandler) {
    if (!this.state.allowedPaths || this.state.allowedPaths.length === 0) {
      const defaultPath = process.cwd()
      await this.emitOutput('\n[设置操作目录] Agent 可在以下目录中读写文件：', onEvent)
      await this.emitOutput(`  默认: ${defaultPath}`, onEvent)

      if (this.askInput) {
        const input = await this.askInput('请输入操作目录（直接回车使用默认，多个目录用逗号分隔）：')
        if (input.trim()) {
          this.state.allowedPaths = input.split(',').map((p) => p.trim()).filter(Boolean)
        } else {
          this.state.allowedPaths = [defaultPath]
        }
      } else {
        this.state.allowedPaths = [defaultPath]
      }

      await this.emitOutput(`[操作目录已设置] ${this.state.allowedPaths.join(', ')}`, onEvent)
      await this.persist()
    }
  }

  async handleUserInput(userInput: string, onEvent?: AgentEventHandler): Promise<void> {
    await this.ensureAllowedPaths(onEvent)

    const normalizedInput = userInput.trim().toLowerCase()
    if (normalizedInput === '取消' || normalizedInput === 'cancel' || normalizedInput === '不做了') {
      await this.handleCancel(onEvent)
      return
    }
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

    if (isPureConfirmationInput(userInput) && this.state.pendingConfirm) {
      await this.handleConfirmResponse(userInput, onEvent)
      return
    }

    try {
      const compressed = await maybeCompressContext(this.state.sessionId)
      if (compressed) {
        await this.emitOutput(`[上下文压缩] 消息过长，已压缩旧对话并保留最近 ${10} 轮`, onEvent)
      }
    } catch (err) {
      console.error('[上下文压缩] 压缩异常，继续执行:', err)
      await onEvent?.({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }

    if (!this.state.goal && !this.state.confirmedRequirement) {
      this.state.goal = userInput
    }

    await this.runAgentTurn(userInput, onEvent)
  }

  private async runAgentTurn(userInput: string, onEvent?: AgentEventHandler): Promise<void> {
    const controller = new AbortController()
    this.abortController = controller
    let result: import('./types.js').AgentResult
    try {
      result = await this.agent.run(this.state.sessionId, userInput, this.state, controller.signal, onEvent, this.metricRecorder)
    } finally {
      if (this.abortController === controller) this.abortController = undefined
    }
    if (controller.signal.aborted) {
      await onEvent?.({ type: 'aborted', message: '中断完成' })
      return
    }
    await onEvent?.({ type: 'result', result })

    await this.handleAgentResult(result, onEvent)
    await this.persist()
  }

  private async handleAgentResult(result: import('./types.js').AgentResult, onEvent?: AgentEventHandler) {
    switch (result.action) {
      case 'chat':
        await this.emitOutput(result.message, onEvent)
        break
      case 'ask_user':
        if (result.message) await this.emitOutput(`\n${result.message}`, onEvent)
        await this.emitOutput('\n[需要你确认]', onEvent)
        result.questions.forEach((q, i) => {
          console.log(`  ${i + 1}. ${q}`)
          void onEvent?.({ type: 'output', message: `  ${i + 1}. ${q}` })
        })
        break
      case 'confirm':
        if (result.message) await this.emitOutput(`\n${result.message}`, onEvent)
        await this.emitOutput(`\n${result.prompt}`, onEvent)
        const allowWrite = result.confirmType === 'allow_write'
        this.state.pendingConfirm = {
          allowWrite,
          message: result.message || result.prompt,
        }
        if (allowWrite) {
          await this.emitOutput('\n⚠️ 确认此方案后，Agent 将获得文件写入权限（增/删/改），请仔细核对方案内容。', onEvent)
        }
        break
      case 'done':
        await this.emitOutput(`\n${result.message}`, onEvent)
        this.clearCurrentTaskState()
        break
    }
  }

  private clearCurrentTaskState(): void {
    this.state.goal = undefined
    this.state.confirmedRequirement = undefined
    this.state.designTasks = undefined
    this.state.completedTaskIds = []
    this.state.failedTaskIds = []
    this.state.pendingConfirm = undefined
    this.state.designConfirmed = false
    this.state.memorySettings = normalizeMemorySettings(this.state.memorySettings)
  }

  private async handleConfirmResponse(userInput: string, onEvent?: AgentEventHandler) {
    const pending = this.state.pendingConfirm!
    this.state.pendingConfirm = undefined

    if (pending.allowWrite) {
      this.state.designConfirmed = true
      await this.emitOutput('\n[已确认] Agent 已获得文件写入权限，开始执行...', onEvent)
    } else {
      this.state.confirmedRequirement = this.state.confirmedRequirement || pending.message
      await this.emitOutput('\n[已确认] 正在继续...', onEvent)
    }
    await this.persist()

    await this.runAgentTurn(userInput, onEvent)
  }

  private async handleSetDirectory(onEvent?: AgentEventHandler) {
    if (this.askInput) {
      await this.emitOutput(`\n当前操作目录: ${this.state.allowedPaths.join(', ')}`, onEvent)
      const input = await this.askInput('请输入新的操作目录（多个目录用逗号分隔）：')
      if (input.trim()) {
        this.state.allowedPaths = input.split(',').map((p) => p.trim()).filter(Boolean)
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
      await execAsync(`git fetch ${githubRepoUrl}`, { cwd: projectPath })

      const { stdout: diffOutput } = await execAsync('git diff HEAD', { cwd: projectPath })
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
        if (!confirmed) {
          await this.emitOutput('[revert] 已取消。', onEvent)
          return
        }
      }

      await execAsync('git checkout .', { cwd: projectPath })
      await this.emitOutput('[revert] 已回退到 GitHub 最新版本。', onEvent)
    } catch (err) {
      console.error('[revert] 执行失败:', err instanceof Error ? err.message : err)
      await onEvent?.({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  // ── Cancel ────────────────────────────────────────────────────────

  private async handleCancel(onEvent?: AgentEventHandler) {
    this.abort()
    this.clearCurrentTaskState()
    await this.persist()
    await this.emitOutput('\n[已取消] 当前任务已清除。', onEvent)
  }
}
