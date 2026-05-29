import type { LlmToolCall } from '../llm/types.js'

export type ContentBlockParam = { type: 'text'; text: string }

export type Message = {
  uuid: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  createdAt: number
  isMeta?: boolean
  isCompressed?: boolean
  // For tool result messages, reference which tool call this result belongs to
  toolName?: string
  toolCallId?: string
  // For assistant messages that contain tool calls
  toolCalls?: LlmToolCall[]
}

export type SDKMessage =
  | { kind: 'delta'; uuid: string; role: 'assistant'; delta: string; createdAt: number }
  | { kind: 'message'; uuid: string; role: 'system' | 'user' | 'assistant' | 'tool'; content: string; createdAt: number; isMeta?: boolean; toolName?: string; toolCallId?: string; toolCalls?: LlmToolCall[] }
  | { kind: 'tool_calls'; toolCalls: LlmToolCall[] }

export type State = {
  messages: Message[]
}

export type Terminal =
  | { type: 'completed' }
  | { type: 'error'; error: string }
