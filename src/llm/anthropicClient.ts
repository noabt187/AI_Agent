import { joinUrl } from '../utils/index.js'
import { parseSseLines } from './sse.js'
import type { LlmClient, LlmStreamEvent, ToolDefinition } from './types.js'
import type { Message } from '../types/index.js'

function convertMessages(messages: Message[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'tool') {
        const prefix = m.toolName ? `[tool_result: ${m.toolName}]` : '[tool_result]'
        return { role: 'user' as const, content: `${prefix}\n${m.content}` }
      }
      if (m.role === 'user') return { role: 'user' as const, content: m.content }
      return { role: 'assistant' as const, content: m.content }
    })
}

export function createAnthropicClient(baseUrl: string, apiKey: string, model: string): LlmClient {
  return {
    async *streamChat(messages: Message[], _tools?: ToolDefinition[], signal?: AbortSignal): AsyncGenerator<LlmStreamEvent, void, unknown> {
      const systemMessage = messages.find((m) => m.role === 'system')

      const body: Record<string, unknown> = {
        model,
        messages: convertMessages(messages),
        stream: true,
        max_tokens: 4096,
      }
      if (systemMessage) {
        body.system = systemMessage.content
      }

      const res = await fetch(joinUrl(baseUrl, 'v1/messages'), {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      })

      if (!res.ok || !res.body) {
        yield { type: 'error', error: `HTTP ${res.status}` }
        return
      }

      for await (const line of parseSseLines(res.body)) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (!data) continue
        try {
          const parsed = JSON.parse(data)
          if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
            const text = parsed.delta?.text
            if (typeof text === 'string' && text) {
              yield { type: 'delta', text }
            }
          }
          if (parsed.type === 'message_stop') {
            yield { type: 'done' }
          }
        } catch {
          continue
        }
      }
    },
  }
}
