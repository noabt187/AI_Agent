import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

export type LlmCallMetric = {
  timestamp: number
  promptTokens: number
  completionTokens: number
  latencyMs: number
  firstTokenMs: number
}

type SessionMetrics = {
  sessionId: string
  startedAt: number
  calls: LlmCallMetric[]
}

const stateDir = resolve(process.cwd(), 'state')

function getMetricsPath(sessionId: string): string {
  return resolve(stateDir, sessionId, 'metrics.json')
}

async function loadMetrics(sessionId: string): Promise<SessionMetrics> {
  const path = getMetricsPath(sessionId)
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as SessionMetrics
  } catch {
    return { sessionId, startedAt: Date.now(), calls: [] }
  }
}

async function saveMetrics(sessionId: string, metrics: SessionMetrics): Promise<void> {
  const sessionDir = resolve(stateDir, sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(getMetricsPath(sessionId), JSON.stringify(metrics, null, 2), 'utf8')
}

export async function recordMetrics(sessionId: string, calls: LlmCallMetric[]): Promise<void> {
  const metrics = await loadMetrics(sessionId)
  metrics.calls.push(...calls)
  await saveMetrics(sessionId, metrics)
}

export function createMetricRecorder(sessionId: string): (metric: LlmCallMetric) => void {
  const pending: LlmCallMetric[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  return (metric: LlmCallMetric) => {
    pending.push(metric)
    if (!flushTimer) {
      flushTimer = setTimeout(async () => {
        const batch = pending.splice(0, pending.length)
        flushTimer = null
        try {
          await recordMetrics(sessionId, batch)
        } catch (err) {
          console.error('[监控] 保存指标失败:', err)
        }
      }, 2000)
    }
  }
}

export async function formatStats(sessionId: string): Promise<string> {
  const metrics = await loadMetrics(sessionId)
  if (metrics.calls.length === 0) {
    return `📊 Session "${sessionId}" 暂无 LLM 调用记录`
  }

  const totalPrompt = metrics.calls.reduce((s, c) => s + c.promptTokens, 0)
  const totalCompletion = metrics.calls.reduce((s, c) => s + c.completionTokens, 0)
  const totalTokens = totalPrompt + totalCompletion
  const totalLatency = metrics.calls.reduce((s, c) => s + c.latencyMs, 0)
  const avgLatency = totalLatency / metrics.calls.length
  const firstTokenTimes = metrics.calls.filter((c) => c.firstTokenMs > 0).map((c) => c.firstTokenMs)
  const avgFirstToken = firstTokenTimes.length > 0
    ? firstTokenTimes.reduce((s, v) => s + v, 0) / firstTokenTimes.length
    : 0

  // doubao-seed-2.0 lite: ¥0.8/M input, ¥2/M output → $/token
  const inputCost = totalPrompt * 0.8 / 1_000_000
  const outputCost = totalCompletion * 2.0 / 1_000_000
  const totalCostCNY = inputCost + outputCost

  const lines = [
    `═══════════════════════════════════════════`,
    `  📊 Session Metrics: ${sessionId}`,
    `═══════════════════════════════════════════`,
    `  LLM 调用次数:    ${metrics.calls.length}`,
    `  输入 Tokens:     ${totalPrompt.toLocaleString()}`,
    `  输出 Tokens:     ${totalCompletion.toLocaleString()}`,
    `  总 Tokens:       ${totalTokens.toLocaleString()}`,
    `  ─────────────────────────────────────────`,
    `  总耗时:          ${(totalLatency / 1000).toFixed(1)}s`,
    `  平均首Token延迟:  ${(avgFirstToken / 1000).toFixed(2)}s`,
    `  平均每次调用耗时: ${(avgLatency / 1000).toFixed(2)}s`,
    `  ─────────────────────────────────────────`,
    `  预估成本:        ¥${totalCostCNY.toFixed(4)}`,
    `═══════════════════════════════════════════`,
  ]
  return lines.join('\n')
}
