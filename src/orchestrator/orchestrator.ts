import { exec } from 'node:child_process'
import { access } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { AgentEventHandler, WorldState } from './types.js'
import { Agent } from './agent.js'
import { maybeCompressContext } from '../context/contextCompressor.js'
import { loadOrchestratorState, saveOrchestratorState } from '../state/sessionStore.js'
import { createMetricRecorder, formatStats } from '../context/monitor.js'
import { saveDesignCheckpoint, loadDesignCheckpoint, createCodeCheckpoint, restoreCodeCheckpoint, listCodeCheckpoints, applySnapshot } from './checkpoint.js'

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
      phase: 'planning',
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
      if (!persisted.phase) persisted.phase = 'planning'
    }
    return new Orchestrator(sessionId, persisted ?? {
      sessionId,
      allowedPaths: [],
      completedTaskIds: [],
      failedTaskIds: [],
      errors: {},
      phase: 'planning',
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
    if (userInput === '/checkpoints') {
      await this.handleListCheckpoints(onEvent)
      return
    }
    if (userInput.startsWith('/checkpoint ')) {
      const label = userInput.split(/\s+/)[1]
      await this.handleRestoreCheckpoint(label, onEvent)
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
        this.state.pendingConfirm = {
          type: result.confirmType || 'requirement',
          message: result.message || result.prompt,
        }
        break
      case 'done':
        await this.emitOutput(`\n${result.message}`, onEvent)
        this.state.pendingConfirm = undefined
        this.state.designConfirmed = false
        this.state.phase = 'planning'
        break
    }
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
      await saveDesignCheckpoint(this.state.sessionId, this.state)
      await this.emitOutput('\n[需求已确认] 正在设计方案...', onEvent)
    } else {
      this.state.designConfirmed = true
      this.state.phase = 'code_generation'
      await onEvent?.({ type: 'phase', phase: 'code_generation' })
      await saveDesignCheckpoint(this.state.sessionId, this.state)
      await this.emitOutput('\n[方案已确认] 正在编写代码...', onEvent)
    }

    await this.persist()

    // Call Agent again to proceed to next step
    this.abortController = new AbortController()
    const result = await this.agent.run(this.state.sessionId, userInput, this.state, this.abortController.signal, onEvent, this.metricRecorder)
    this.abortController = undefined
    await onEvent?.({ type: 'result', result })

    await this.handleAgentResult(result, onEvent)
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
      await this.emitOutput(`\n[revert] 正在拉取远程最新版本...`, onEvent)
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
      console.error(`[revert] 执行失败:`, err instanceof Error ? err.message : err)
      await onEvent?.({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  // ── Checkpoints ─────────────────────────────────────────────────────

  private async handleListCheckpoints(onEvent?: AgentEventHandler) {
    // 设计 checkpoint
    const designSnapshot = await loadDesignCheckpoint(this.state.sessionId)
    await this.emitOutput('\n[checkpoint] 设计断点：', onEvent)
    if (designSnapshot) {
      const preview = designSnapshot.confirmedRequirement?.slice(0, 80) || designSnapshot.goal?.slice(0, 80) || '无'
      await this.emitOutput(`  design — ${preview}...`, onEvent)
    } else {
      await this.emitOutput('  （无）', onEvent)
    }

    // 代码 checkpoint
    const codeEntries = await listCodeCheckpoints(this.state.sessionId)
    await this.emitOutput('\n[checkpoint] 代码断点：', onEvent)
    if (codeEntries.length === 0) {
      await this.emitOutput('  （无）', onEvent)
    } else {
      for (const entry of codeEntries) {
        const time = new Date(entry.timestamp).toLocaleTimeString()
        await this.emitOutput(`  ${entry.label} - ${time} - ${entry.commitHash.slice(0, 8)}`, onEvent)
      }
    }

    await this.emitOutput('\n使用 /checkpoint design 回到设计断点（不回退代码）', onEvent)
    await this.emitOutput('使用 /checkpoint <label> 回到代码断点（回退代码）', onEvent)
  }

  private async handleRestoreCheckpoint(targetLabel: string, onEvent?: AgentEventHandler) {
    // 设计 checkpoint：只恢复 WorldState，不回退代码
    if (targetLabel === 'design') {
      const snapshot = await loadDesignCheckpoint(this.state.sessionId)
      if (!snapshot) {
        await this.emitOutput('\n[checkpoint] 未找到设计断点。', onEvent)
        return
      }

      if (this.askConfirm) {
        const confirmed = await this.askConfirm('确认回到设计断点？当前方案将被恢复。')
        if (!confirmed) {
          await this.emitOutput('[checkpoint] 已取消。', onEvent)
          return
        }
      }

      applySnapshot(this.state, snapshot)
      this.state.pendingConfirm = undefined
      await this.persist()
      await this.emitOutput('\n[checkpoint] 已回到设计断点。', onEvent)
      return
    }

    // 代码 checkpoint：恢复 WorldState + 回退代码
    if (this.askConfirm) {
      const confirmed = await this.askConfirm(`确认回到 "${targetLabel}" 代码断点？代码将被回退。`)
      if (!confirmed) {
        await this.emitOutput('[checkpoint] 已取消。', onEvent)
        return
      }
    }

    const snapshot = await restoreCodeCheckpoint(this.state.sessionId, targetLabel, this.state)
    if (!snapshot) {
      await this.emitOutput(`\n[checkpoint] 未找到 "${targetLabel}" 代码断点。`, onEvent)
      return
    }

    applySnapshot(this.state, snapshot)
    this.state.pendingConfirm = undefined
    await this.persist()
    await this.emitOutput(`\n[checkpoint] 已回到 "${targetLabel}" 代码断点，代码已回退。`, onEvent)
  }

  // ── Cancel ────────────────────────────────────────────────────────

  private async handleCancel(onEvent?: AgentEventHandler) {
    // 先中断正在运行的 Agent（如果有的话）
    this.abort()
    this.state.goal = undefined
    this.state.confirmedRequirement = undefined
    this.state.designTasks = undefined
    this.state.completedTaskIds = []
    this.state.failedTaskIds = []
    this.state.errors = {}
    this.state.pendingConfirm = undefined
    this.state.designConfirmed = false
    this.state.phase = 'planning'
    await this.persist()
    await this.emitOutput('\n[已取消] 当前任务已清除。', onEvent)
  }
}
