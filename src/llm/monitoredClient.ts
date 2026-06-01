import type { LlmClient, LlmStreamEvent, ToolDefinition } from './types.js'
import type { Message } from '../types/index.js'

export type LlmCallMetric = {
  timestamp: number
  promptTokens: number
  completionTokens: number
  latencyMs: number
  firstTokenMs: number
}

export type MetricCallback = (metric: LlmCallMetric) => void

export function createMonitoredClient(inner: LlmClient, onMetric: MetricCallback): LlmClient {
  return {
    async *streamChat(messages: Message[], tools?: ToolDefinition[], signal?: AbortSignal): AsyncGenerator<LlmStreamEvent, void, unknown> {
      const startMs = Date.now()
      let firstTokenMs = 0

      for await (const evt of inner.streamChat(messages, tools, signal)) {
        if (evt.type === 'delta' && firstTokenMs === 0) {
          firstTokenMs = Date.now()
        }
        if (evt.type === 'done') {
          const endMs = Date.now()
          onMetric({
            timestamp: startMs,
            promptTokens: evt.usage?.promptTokens ?? 0,
            completionTokens: evt.usage?.completionTokens ?? 0,
            latencyMs: endMs - startMs,
            firstTokenMs: firstTokenMs > 0 ? firstTokenMs - startMs : 0,
          })
        }
        yield evt
      }
    },
  }
}
