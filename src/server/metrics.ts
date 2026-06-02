import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export type MetricsCall = {
  timestamp: number
  promptTokens: number
  completionTokens: number
  latencyMs: number
  firstTokenMs: number
}

export type MetricsSummary = {
  callCount: number
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  averageLatencyMs: number
  averageFirstTokenMs: number
}

export type SessionMetrics = {
  sessionId: string
  startedAt: number | null
  calls: MetricsCall[]
  summary: MetricsSummary
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeCall(raw: unknown): MetricsCall {
  const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    timestamp: asNumber(item.timestamp),
    promptTokens: asNumber(item.promptTokens),
    completionTokens: asNumber(item.completionTokens),
    latencyMs: asNumber(item.latencyMs),
    firstTokenMs: asNumber(item.firstTokenMs),
  }
}

function summarize(calls: MetricsCall[]): MetricsSummary {
  const callCount = calls.length
  const totalPromptTokens = calls.reduce((sum, call) => sum + call.promptTokens, 0)
  const totalCompletionTokens = calls.reduce((sum, call) => sum + call.completionTokens, 0)
  const totalLatencyMs = calls.reduce((sum, call) => sum + call.latencyMs, 0)
  const totalFirstTokenMs = calls.reduce((sum, call) => sum + call.firstTokenMs, 0)

  return {
    callCount,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens: totalPromptTokens + totalCompletionTokens,
    averageLatencyMs: callCount === 0 ? 0 : Math.round(totalLatencyMs / callCount),
    averageFirstTokenMs: callCount === 0 ? 0 : Math.round(totalFirstTokenMs / callCount),
  }
}

export async function loadMetricsFromStateDir(stateDir: string, sessionId: string): Promise<SessionMetrics> {
  const metricsPath = resolve(stateDir, sessionId, 'metrics.json')

  try {
    const raw = await readFile(metricsPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const calls = Array.isArray(parsed.calls) ? parsed.calls.map(normalizeCall) : []
    return {
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : sessionId,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : null,
      calls,
      summary: summarize(calls),
    }
  } catch {
    return {
      sessionId,
      startedAt: null,
      calls: [],
      summary: summarize([]),
    }
  }
}
