import type { Message } from '../types/index.js'

export type LlmStreamDelta = { type: 'delta'; text: string }
export type LlmStreamToolCalls = { type: 'tool_calls'; toolCalls: LlmToolCall[] }
export type LlmStreamDone = { type: 'done' }
export type LlmStreamError = { type: 'error'; error: string }

export type LlmStreamEvent = LlmStreamDelta | LlmStreamDone | LlmStreamError | LlmStreamToolCalls

export type LlmToolCall = {
  id: string
  name: string
  arguments: string // JSON string, parse with JSON.parse
}

export type ToolDefinition = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, { type: string; description: string }>
      required: string[]
    }
  }
}

export type LlmClient = {
  streamChat(messages: Message[], tools?: ToolDefinition[]): AsyncGenerator<LlmStreamEvent, void, unknown>
}
