import { joinUrl } from '../utils/index.js'
import { parseSseLines } from './sse.js'
import type { LlmClient, LlmStreamEvent, ToolDefinition } from './types.js'
import type { Message } from '../types/index.js'

function convertMessages(messages: Message[]): Array<{ role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string }> {
  return messages.map((m) => {
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

      for await (const line of parseSseLines(res.body)) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') {
          yield { type: 'done' }
          break
        }
        try {
          const parsed = JSON.parse(data)
          const delta = parsed.choices?.[0]?.delta
          if (!delta) {
            if (parsed.choices?.[0]?.finish_reason) {
              // Flush accumulated tool calls before done
              if (toolCallsAcc.size > 0) {
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
              yield { type: 'done' }
            }
            continue
          }

          // Text content
          const content = delta.content
          if (typeof content === 'string' && content) {
            yield { type: 'delta', text: content }
          }

          // Tool calls
          if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
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

          // Finish reason
          if (parsed.choices?.[0]?.finish_reason) {
            if (toolCallsAcc.size > 0) {
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
            if (parsed.choices[0].finish_reason !== 'tool_calls') {
              yield { type: 'done' }
            }
          }
        } catch {
          continue
        }
      }
    },
  }
}
