import { exec } from 'node:child_process'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { AgentEventHandler, WorldState } from './types.js'
import { Agent } from './agent.js'
import { maybeCompressContext } from '../context/contextCompressor.js'
import { loadOrchestratorState, saveOrchestratorState } from '../state/sessionStore.js'
import { createMetricRecorder, formatStats } from '../context/monitor.js'
import { buildWorkflowSnapshot, loadSkills, resolveNextNode, selectActiveSkills } from '../skills/index.js'
import {
  appendPinnedProjectMemory,
  createAndStoreProjectMemory,
  deletePinnedProjectMemory,
  loadPinnedProjectMemories,
  type PinnedProjectMemory,
} from '../memory/projectMemory.js'
import { isMemoryRecallMode, normalizeMemorySettings, type MemoryRecallMode, type MemorySettings } from './types.js'

const execAsync = promisify(exec)
const SKILLS_DIR = resolve(import.meta.dirname ?? process.cwd(), '../skills')

type AskConfirmFn = (question: string) => Promise<boolean>
type AskInputFn = (question: string) => Promise<string>

export class Orchestrator {
  state: WorldState
  private askConfirm?: AskConfirmFn
  private askInput?: AskInputFn
  private agent = new Agent()
  private abortController?: AbortController
  private metricRecorder: (metric: import('../llm/monitoredClient.js').LlmCallMetric) => void

  constructor(sessionId: string, initialState?: WorldState) {
    this.state = initialState ?? {
      sessionId,
      allowedPaths: [],
      memorySettings: normalizeMemorySettings(),
      completedTaskIds: [],
      failedTaskIds: [],
      errors: {},
    }
    this.state.memorySettings = normalizeMemorySettings(this.state.memorySettings)
    this.metricRecorder = createMetricRecorder(this.state.sessionId)
  }

  static async load(sessionId: string): Promise<Orchestrator> {
    const persisted = await loadOrchestratorState<WorldState>(sessionId)
    if (persisted) {
      persisted.allowedPaths = persisted.allowedPaths || []
      persisted.completedTaskIds = persisted.completedTaskIds || []
      persisted.failedTaskIds = persisted.failedTaskIds || []
      persisted.errors = persisted.errors || {}
      persisted.memorySettings = normalizeMemorySettings(persisted.memorySettings)
    }
    return new Orchestrator(sessionId, persisted ?? {
      sessionId,
      allowedPaths: [],
      memorySettings: normalizeMemorySettings(),
      completedTaskIds: [],
      failedTaskIds: [],
      errors: {},
    })
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

  async getMemoryState(): Promise<{ settings: MemorySettings; pinned: PinnedProjectMemory[] }> {
    this.state.memorySettings = normalizeMemorySettings(this.state.memorySettings)
    return {
      settings: this.state.memorySettings,
      pinned: await loadPinnedProjectMemories(this.getProjectDir()),
    }
  }

  async setMemoryRecallMode(mode: MemoryRecallMode): Promise<void> {
    this.state.memorySettings = { recallMode: mode }
    await this.persist()
  }

  async rememberProjectMemory(content: string): Promise<{ memory: PinnedProjectMemory; created: boolean }> {
    return appendPinnedProjectMemory(this.getProjectDir(), content, this.state.sessionId)
  }

  async forgetProjectMemory(id: string): Promise<boolean> {
    return deletePinnedProjectMemory(this.getProjectDir(), id)
  }

  private async resolveConfirmWorkflow(userInput: string, allowWrite: boolean): Promise<{ currentNode: string; nextNode: string } | undefined> {
    const skills = await loadSkills(SKILLS_DIR)
    const snapshot = buildWorkflowSnapshot(this.state, userInput)
    const selected = selectActiveSkills(skills, snapshot)
    const currentSkill = selected.primary
    const currentNode = currentSkill?.node || currentSkill?.name || snapshot.node
    const defaultNext = allowWrite
      ? currentSkill?.onAllowWriteNext || 'code-generation'
      : currentSkill?.onConfirmNext || 'solution-design'
    const nextNode = resolveNextNode(currentNode, defaultNext, skills)
    return nextNode ? { currentNode, nextNode } : undefined
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

    if (this.isConfirmationInput(userInput) && this.state.pendingConfirm) {
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

    this.abortController = new AbortController()
    const result = await this.agent.run(this.state.sessionId, userInput, this.state, this.abortController.signal, onEvent, this.metricRecorder)
    this.abortController = undefined
    await onEvent?.({ type: 'result', result })

    await this.handleAgentResult(result, onEvent, userInput)
    await this.persist()
  }

  private async handleAgentResult(result: import('./types.js').AgentResult, onEvent?: AgentEventHandler, userInput = '') {
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
          workflow: await this.resolveConfirmWorkflow(userInput, allowWrite),
        }
        if (allowWrite) {
          await this.emitOutput('\n⚠️ 确认此方案后，Agent 将获得文件写入权限（增/删/改），请仔细核对方案内容。', onEvent)
        }
        break
      case 'done':
        await this.emitOutput(`\n${result.message}`, onEvent)
        await this.storeProjectMemory(result.message, onEvent)
        this.clearCurrentTaskState()
        break
    }
  }

  private async storeProjectMemory(doneMessage: string, onEvent?: AgentEventHandler) {
    const projectDir = this.state.allowedPaths[0] ?? process.cwd()
    try {
      const memory = await createAndStoreProjectMemory({
        projectDir,
        sessionId: this.state.sessionId,
        state: this.state,
        doneMessage,
      })
      if (memory) {
        await this.emitOutput('\n[项目记忆] 已保存本次完成任务的结构化记忆。', onEvent)
      }
    } catch (err) {
      console.error('[项目记忆] 保存失败:', err)
    }
  }

  private isConfirmationInput(input: string): boolean {
    const trimmed = input.trim().toLowerCase()
    return trimmed === '确认' || trimmed === '是' || trimmed === 'yes' || trimmed === 'y'
      || trimmed === 'ok' || trimmed === '好' || trimmed === '可以' || trimmed === '开始'
      || trimmed === '确认方案' || trimmed === '开始写' || trimmed === '开始编写'
  }

  private clearCurrentTaskState(): void {
    this.state.goal = undefined
    this.state.confirmedRequirement = undefined
    this.state.designTasks = undefined
    this.state.completedTaskIds = []
    this.state.failedTaskIds = []
    this.state.errors = {}
    this.state.pendingConfirm = undefined
    this.state.designConfirmed = false
    this.state.workflow = undefined
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
    const nextNode = pending.workflow?.nextNode ?? buildWorkflowSnapshot(this.state, userInput).node
    this.state.workflow = { node: nextNode }

    await this.persist()

    this.abortController = new AbortController()
    const result = await this.agent.run(this.state.sessionId, userInput, this.state, this.abortController.signal, onEvent, this.metricRecorder)
    this.abortController = undefined
    await onEvent?.({ type: 'result', result })

    await this.handleAgentResult(result, onEvent, userInput)
    await this.persist()
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
    await this.emitOutput(`\n[memory] 召回模式: ${memory.settings.recallMode}`, onEvent)
    await this.emitOutput(`[memory] 项目固定记忆: ${memory.pinned.length} 条`, onEvent)
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
      const { pinned } = await this.getMemoryState()
      await this.emitOutput('\n[memory] 项目固定记忆:', onEvent)
      if (pinned.length === 0) {
        await this.emitOutput('  （无）', onEvent)
        return
      }
      for (const item of pinned) {
        await this.emitOutput(`  ${item.id} - ${item.content}`, onEvent)
      }
      return
    }

    if (action === 'forget') {
      const id = parts[2]
      if (!id) {
        await this.emitOutput('\n[memory] 用法: /memory forget <id>', onEvent)
        return
      }
      const deleted = await this.forgetProjectMemory(id)
      await this.emitOutput(deleted ? `\n[memory] 已删除固定记忆: ${id}` : `\n[memory] 未找到固定记忆: ${id}`, onEvent)
      return
    }

    await this.emitOutput('\n[memory] 未识别的命令。用法: /memory auto|off|on|list|forget <id>', onEvent)
  }

  private async handleRememberCommand(input: string, onEvent?: AgentEventHandler) {
    const content = input.replace(/^\/remember\b/, '').trim()
    if (!content) {
      await this.emitOutput('\n[remember] 用法: /remember <需要项目内长期记住的内容>', onEvent)
      return
    }

    try {
      const { memory, created } = await this.rememberProjectMemory(content)
      await this.emitOutput(
        created
          ? `\n[remember] 已保存项目固定记忆: ${memory.id}`
          : `\n[remember] 已存在相同固定记忆: ${memory.id}`,
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
