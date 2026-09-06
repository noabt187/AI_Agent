import type { Message } from '../types/index.js'

type LlmStreamDelta = { type: 'delta'; text: string }
type LlmStreamToolCalls = { type: 'tool_calls'; toolCalls: LlmToolCall[] }
type LlmStreamDone = { type: 'done'; usage?: { promptTokens: number; completionTokens: number } }
type LlmStreamError = { type: 'error'; error: string }

export type LlmStreamEvent = LlmStreamDelta | LlmStreamDone | LlmStreamError | LlmStreamToolCalls

export type LlmToolCall = {
  id: string
  name: string
  arguments: string // JSON string, parse with JSON.parse
}

export type ToolSchemaProperty = {
  type: string
  description?: string
  enum?: string[]
  items?: { type: string }
}

export type ToolDefinition = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, ToolSchemaProperty>
      required: string[]
    }
  }
}

export type LlmClient = {
  streamChat(messages: Message[], tools?: ToolDefinition[], signal?: AbortSignal): AsyncGenerator<LlmStreamEvent, void, unknown>
}
