import { joinUrl } from '../utils/index.js'
import { parseSseLines } from './sse.js'
import type { LlmClient, LlmStreamEvent, ToolDefinition } from './types.js'
import type { Message } from '../types/index.js'

function convertMessages(messages: Message[]): Array<{ role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }> {
  return messages
    .filter((m) => !m.isMeta)
    .map((m) => {
    if (m.role === 'tool') {
      // Only send as native tool message if we have a valid tool_call_id
      if (m.toolCallId) {
        return { role: 'tool', content: m.content, tool_call_id: m.toolCallId }
      }
      // Legacy tool result without id — send as user message with prefix
      const prefix = m.toolName ? `[tool_result: ${m.toolName}]` : '[tool_result]'
      return { role: 'user', content: `${prefix}\n${m.content}` }
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      }
    }
    return { role: m.role, content: m.content }
  })
}

export function createOpenAiClient(baseUrl: string, apiKey: string, model: string): LlmClient {
  return {
    async *streamChat(messages: Message[], tools?: ToolDefinition[], signal?: AbortSignal): AsyncGenerator<LlmStreamEvent, void, unknown> {
      const body: Record<string, unknown> = {
        model,
        messages: convertMessages(messages),
        stream: true,
        stream_options: { include_usage: true },
      }
      if (tools && tools.length > 0) {
        body.tools = tools
      }

      const res = await fetch(joinUrl(baseUrl, 'chat/completions'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      })

      if (!res.ok || !res.body) {
        let detail = ''
        try { detail = await res.text() } catch {}
        yield { type: 'error', error: `HTTP ${res.status}${detail ? ': ' + detail.slice(0, 500) : ''}` }
        return
      }

      // Accumulate tool calls by index (streaming chunks)
      const toolCallsAcc = new Map<number, { id: string; name: string; arguments: string }>()
      let usage: { promptTokens: number; completionTokens: number } | undefined
      let doneYielded = false

      // Helper: yield accumulated tool calls as a tool_calls event
      const flushToolCalls = function* (): Generator<LlmStreamEvent> {
        if (toolCallsAcc.size === 0) return
        yield {
          type: 'tool_calls',
          toolCalls: Array.from(toolCallsAcc.values()).map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          })),
        }
        toolCallsAcc.clear()
      }

      // Helper: flush tool calls + yield done if not already yielded
      const yieldDoneIfNeeded = function* (): Generator<LlmStreamEvent> {
        if (doneYielded) return
        yield* flushToolCalls()
        yield { type: 'done', usage }
        doneYielded = true
      }

      for await (const line of parseSseLines(res.body, signal)) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') {
          yield* yieldDoneIfNeeded()
          break
        }
        try {
          const parsed = JSON.parse(data)

          // Capture usage from any chunk that carries it (do this FIRST —
          // usage may appear in the same chunk as finish_reason + delta)
          if (parsed.usage) {
            usage = {
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0,
            }
          }

          const delta = parsed.choices?.[0]?.delta
          const finishReason: string | undefined = parsed.choices?.[0]?.finish_reason

          // Text content
          const content = delta?.content
          if (typeof content === 'string' && content) {
            yield { type: 'delta', text: content }
          }

          // Tool calls accumulation
          if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx: number = tc.index ?? 0
              if (!toolCallsAcc.has(idx)) {
                toolCallsAcc.set(idx, { id: tc.id || '', name: '', arguments: '' })
              }
              const acc = toolCallsAcc.get(idx)!
              if (tc.id) acc.id = tc.id
              if (tc.function?.name) acc.name = tc.function.name
              if (tc.function?.arguments) acc.arguments += tc.function.arguments
            }
          }

          // Handle finish_reason
          if (finishReason) {
            if (finishReason === 'tool_calls') {
              // Flush tool calls but don't end the stream — more calls follow
              yield* flushToolCalls()
            } else if (usage) {
              // We have both finish_reason and usage — yield done immediately
              yield* yieldDoneIfNeeded()
            }
            // If no usage yet, don't yield done here; the standalone usage
            // chunk, [DONE], or post-loop safety net will handle it.
          }
        } catch {
          continue
        }
      }

      // Safety net: if the stream ended without yielding done (e.g., some
      // APIs omit the [DONE] marker), yield it now so the metric is recorded.
      yield* yieldDoneIfNeeded()
    },
  }
}
