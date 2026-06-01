import { exec } from 'node:child_process'
import { access } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { AgentEventHandler, WorldState } from './types.js'
import { Agent } from './agent.js'
import { maybeCompressContext } from '../context/contextCompressor.js'
import { loadOrchestratorState, saveOrchestratorState } from '../state/sessionStore.js'
import { createMetricRecorder, formatStats } from '../context/monitor.js'

const execAsync = promisify(exec)

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
      completedTaskIds: [],
      failedTaskIds: [],
      errors: {},
    }
    this.metricRecorder = createMetricRecorder(this.state.sessionId)
  }

  static async load(sessionId: string): Promise<Orchestrator> {
    const persisted = await loadOrchestratorState<WorldState>(sessionId)
    if (persisted) {
      persisted.allowedPaths = persisted.allowedPaths || []
      persisted.completedTaskIds = persisted.completedTaskIds || []
      persisted.failedTaskIds = persisted.failedTaskIds || []
      persisted.errors = persisted.errors || {}
    }
    return new Orchestrator(sessionId, persisted ?? {
      sessionId,
      allowedPaths: [],
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

  // ── allowedPaths ──────────────────────────────────────────────────

  private async ensureAllowedPaths(onEvent?: AgentEventHandler) {
    if (!this.state.allowedPaths || this.state.allowedPaths.length === 0) {
      const defaultPath = process.cwd()
      await this.emitOutput(`\n[设置操作目录] Agent 可在以下目录中读写文件：`, onEvent)
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

  // ── Main Entry ──────────────────────────────────────────────────

  async handleUserInput(userInput: string, onEvent?: AgentEventHandler): Promise<void> {
    await this.ensureAllowedPaths(onEvent)

    // Hardcoded shortcuts
    if (userInput === '取消' || userInput === 'cancel' || userInput === '不做了') {
      await this.handleCancel(onEvent)
      return
    }
    if (userInput === '设置目录') {
      await this.handleSetDirectory(onEvent)
      return
    }
    if (userInput.startsWith('/revert')) {
      await this.handleRevert(userInput)
      return
    }
    if (userInput === '/stats') {
      const report = await formatStats(this.state.sessionId)
      console.log(`\n${report}`)
      return
    }

    // Handle confirmation response
    if (this.isConfirmationInput(userInput) && this.state.pendingConfirm) {
      await this.handleConfirmResponse(userInput, onEvent)
      return
    }

    // Context compression
    let compressed = false
    try {
      compressed = await maybeCompressContext(this.state.sessionId)
      if (compressed) {
        await this.emitOutput(`[上下文压缩] 消息过长，已压缩旧对话并保留最近 ${10} 轮`, onEvent)
      }
    } catch (err) {
      console.error('[上下文压缩] 压缩异常，继续执行:', err)
      await onEvent?.({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }

    // Track goal on first development input
    if (!this.state.goal && !this.state.confirmedRequirement) {
      this.state.goal = userInput
    }

    // Run Agent
    this.abortController = new AbortController()
    const result = await this.agent.run(this.state.sessionId, userInput, this.state, this.abortController.signal, onEvent, this.metricRecorder)
    this.abortController = undefined
    await onEvent?.({ type: 'result', result })

    // Handle result
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
        // Save pending confirm for next user input
        if (result.message) {
          this.state.pendingConfirm = {
            type: result.confirmType || 'requirement',
            message: result.message,
          }
        }
        break

      case 'done':
        await this.emitOutput(`\n${result.message}`, onEvent)
        // Clear state after completion
        this.state.pendingConfirm = undefined
        break
    }

    await this.persist()
  }

  private isConfirmationInput(input: string): boolean {
    const trimmed = input.trim().toLowerCase()
    return trimmed === '确认' || trimmed === '是' || trimmed === 'yes' || trimmed === 'y'
      || trimmed === 'ok' || trimmed === '好' || trimmed === '可以' || trimmed === '开始'
      || trimmed === '确认方案' || trimmed === '开始写' || trimmed === '开始编写'
  }

  private async handleConfirmResponse(userInput: string, onEvent?: AgentEventHandler) {
    const pending = this.state.pendingConfirm!
    this.state.pendingConfirm = undefined

    if (pending.type === 'requirement') {
      this.state.confirmedRequirement = pending.message
      await this.emitOutput('\n[需求已确认] 正在设计方案...', onEvent)
    } else {
      await this.emitOutput('\n[方案已确认] 正在编写代码...', onEvent)
    }

    await this.persist()

    // Call Agent again to proceed to next step
    this.abortController = new AbortController()
    const result = await this.agent.run(this.state.sessionId, userInput, this.state, this.abortController.signal, onEvent, this.metricRecorder)
    this.abortController = undefined
    await onEvent?.({ type: 'result', result })

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
        if (result.message) {
          this.state.pendingConfirm = {
            type: result.confirmType || 'requirement',
            message: result.message,
          }
        }
        break
      case 'done':
        await this.emitOutput(`\n${result.message}`, onEvent)
        this.state.pendingConfirm = undefined
        break
    }

    await this.persist()
  }

  // ── Set Directory ─────────────────────────────────────────────────

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

  // ── Revert ──────────────────────────────────────────────────────────

  private async handleRevert(input: string, onEvent?: AgentEventHandler) {
    const parts = input.split(/\s+/)
    if (parts.length < 3) {
      await this.emitOutput('\n[用法] /revert <项目路径> <GitHub仓库地址>', onEvent)
      await this.emitOutput('[示例] /revert D:\\my_test\\conduit-realworld-example-app https://github.com/xxx/xxx.git', onEvent)
      return
    }

    const projectPath = parts[1]
    const githubRepoUrl = parts[2]

    // 验证目录存在
    try {
      await access(projectPath)
    } catch {
      await this.emitOutput(`\n[错误] 目录不存在: ${projectPath}`, onEvent)
      return
    }

    // 验证是 git 仓库
    try {
      await access(`${projectPath}/.git`)
    } catch {
      await this.emitOutput(`\n[错误] 该目录不是 git 仓库: ${projectPath}`, onEvent)
      return
    }

    try {
      // 1. fetch 远程最新版本
      await this.emitOutput(`\n[revert] 正在拉取远程最新版本...`, onEvent)
      await execAsync(`git fetch ${githubRepoUrl}`, { cwd: projectPath })

      // 2. diff 展示改动
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

      // 3. 确认回退
      if (this.askConfirm) {
        const confirmed = await this.askConfirm('\n确认丢弃以上所有改动？')
        if (!confirmed) {
          await this.emitOutput('[revert] 已取消。', onEvent)
          return
        }
      }

      // 4. checkout 丢弃改动
      await execAsync('git checkout .', { cwd: projectPath })
      await this.emitOutput('[revert] 已回退到 GitHub 最新版本。', onEvent)
    } catch (err) {
      console.error(`[revert] 执行失败:`, err instanceof Error ? err.message : err)
      await onEvent?.({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  // ── Cancel ────────────────────────────────────────────────────────

  private async handleCancel(onEvent?: AgentEventHandler) {
    this.state.goal = undefined
    this.state.confirmedRequirement = undefined
    this.state.designTasks = undefined
    this.state.completedTaskIds = []
    this.state.failedTaskIds = []
    this.state.errors = {}
    this.state.pendingConfirm = undefined
    await this.persist()
    await this.emitOutput('\n[已取消] 当前任务已清除。', onEvent)
  }
}
