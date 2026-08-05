import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadModelConfig } from '../../src/context/modelConfig.js'
import { saveMemory } from '../../src/memory/projectMemory.js'
import { Orchestrator } from '../../src/orchestrator/orchestrator.js'
import type { AgentEvent, AgentResult, WorldState } from '../../src/orchestrator/types.js'
import { normalizeMemorySettings } from '../../src/orchestrator/types.js'
import { loadMetricsFromStateDir } from '../../src/server/metrics.js'
import { gradeTrial } from '../graders/index.js'
import type { EvalTask, ToolCallTrace, TrialRecord } from '../types.js'
import { prepareTrialWorkspace } from './workspace.js'

const WRITE_TOOLS = new Set([
  'writeFile',
  'deleteFile',
  'createPullRequest',
  'forkRepository',
  'cloneRepository',
  'saveCheckpoint',
])

function isToolResultError(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { ok?: unknown }
    if (typeof parsed.ok === 'boolean') return !parsed.ok
  } catch {}
  return /^(错误|工具执行错误)|\berror\b|failed|failure/i.test(raw.trim())
}

function safeParseArguments(raw: string): { valid: boolean; parsed?: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { valid: true, parsed: parsed as Record<string, unknown> }
      : { valid: false }
  } catch {
    return { valid: false }
  }
}

function findPendingToolCall(calls: ToolCallTrace[], name: string): ToolCallTrace | undefined {
  return calls.find((call) => call.name === name && call.result === undefined)
}

async function waitForMetricFlush(): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2300))
}

export async function runTrial(params: {
  task: EvalTask
  repetition: number
  runsRoot: string
  timeoutMs?: number
}): Promise<TrialRecord> {
  const { task, repetition, runsRoot } = params
  const trialId = `${task.id}-r${repetition}`
  const started = Date.now()
  const startedAt = new Date(started).toISOString()
  const { workspace, baseline } = await prepareTrialWorkspace(task, runsRoot, trialId)
  const cfg = await loadModelConfig()
  const sessionId = `eval-${resolve(runsRoot).split(/[\\/]/).at(-1)}-${trialId}`
  const events: AgentEvent[] = []
  const toolCalls: ToolCallTrace[] = []
  let finalResult: AgentResult | undefined
  let orchestrator: Orchestrator | undefined
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined

  const initialState: WorldState = {
    sessionId,
    allowedPaths: [workspace],
    memorySettings: normalizeMemorySettings({ recallMode: 'auto' }),
    completedTaskIds: [],
    failedTaskIds: [],
    designConfirmed: false,
  }

  const recordEvent = async (event: AgentEvent): Promise<void> => {
    events.push(event)
    if (event.type === 'result') finalResult = event.result
    if (event.type === 'tool_call') {
      const parsed = safeParseArguments(event.arguments)
      toolCalls.push({
        name: event.name,
        arguments: event.arguments,
        parsedArguments: parsed.parsed,
        argumentJsonValid: parsed.valid,
        beforeWriteAuthorization: WRITE_TOOLS.has(event.name) && !(orchestrator?.state.designConfirmed ?? false),
      })
    }
    if (event.type === 'tool_result') {
      const call = findPendingToolCall(toolCalls, event.name)
      if (call) {
        call.result = event.result
        call.resultIsError = isToolResultError(event.result)
      }
    }
  }

  try {
    await mkdir(runsRoot, { recursive: true })
    if (task.memory) {
      await saveMemory({
        layer: 'project',
        projectDir: workspace,
        sessionId,
        type: 'project',
        ...task.memory,
      })
    }

    orchestrator = new Orchestrator(sessionId, initialState)
    const timeoutMs = params.timeoutMs ?? 300_000
    timeoutHandle = setTimeout(() => orchestrator?.abort(), timeoutMs)

    await orchestrator.handleUserInput(task.prompt, recordEvent)
    for (let confirmation = 0; confirmation < 4; confirmation++) {
      if (!task.autoConfirm || !orchestrator.state.pendingConfirm) break
      await orchestrator.handleUserInput('确认', recordEvent)
    }

    await waitForMetricFlush()
    const storedMetrics = await loadMetricsFromStateDir(resolve(process.cwd(), 'state'), sessionId)
    const durationMs = Date.now() - started
    const trial: TrialRecord = {
      trialId,
      taskId: task.id,
      taskTitle: task.title,
      repetition,
      startedAt,
      workspace,
      model: cfg.model,
      status: 'failed',
      finalResult,
      events,
      toolCalls,
      metrics: {
        llmCallCount: storedMetrics.summary.callCount,
        promptTokens: storedMetrics.summary.totalPromptTokens,
        completionTokens: storedMetrics.summary.totalCompletionTokens,
        totalTokens: storedMetrics.summary.totalTokens,
        averageLatencyMs: storedMetrics.summary.averageLatencyMs,
        averageFirstTokenMs: storedMetrics.summary.averageFirstTokenMs,
        durationMs,
        toolCallCount: toolCalls.length,
        providerRetryCount: events.filter((event) => event.type === 'retry').length,
        nativeControlActionCount: toolCalls.filter((call) => (
          call.name === 'request_confirmation' || call.name === 'ask_user' || call.name === 'finish'
        )).length,
        protocolFallbackCount: events.filter((event) => event.type === 'protocol_fallback').length,
        protocolViolationCount: events.filter((event) => event.type === 'protocol_violation').length,
      },
    }

    const emptyResponse = finalResult?.action === 'chat' && /空响应|empty response/i.test(finalResult.message)
    if (storedMetrics.summary.callCount === 0 && emptyResponse) {
      trial.status = 'infrastructure_error'
      trial.error = 'Model returned no usable response and no completed call metric was recorded.'
      return trial
    }

    trial.grade = await gradeTrial(task, trial, baseline)
    trial.status = trial.grade.passed ? 'passed' : 'failed'
    return trial
  } catch (error) {
    return {
      trialId,
      taskId: task.id,
      taskTitle: task.title,
      repetition,
      startedAt,
      workspace,
      model: cfg.model,
      status: 'infrastructure_error',
      finalResult,
      events,
      toolCalls,
      metrics: {
        llmCallCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        averageLatencyMs: 0,
        averageFirstTokenMs: 0,
        durationMs: Date.now() - started,
        toolCallCount: toolCalls.length,
        providerRetryCount: events.filter((event) => event.type === 'retry').length,
        nativeControlActionCount: toolCalls.filter((call) => (
          call.name === 'request_confirmation' || call.name === 'ask_user' || call.name === 'finish'
        )).length,
        protocolFallbackCount: events.filter((event) => event.type === 'protocol_fallback').length,
        protocolViolationCount: events.filter((event) => event.type === 'protocol_violation').length,
      },
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}
