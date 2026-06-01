import type { LlmClient, LlmToolCall, ToolDefinition } from './llm/types.js'
import type {
  ContentBlockParam,
  SDKMessage,
  State,
  Terminal,
  Message,
} from './types/index.js'
import { loadMessages, saveMessages } from './state/sessionStore.js'
import { newUuid, toTextPrompt } from './utils/index.js'

export type QueryEngineParams = {
  sessionId: string
  llmClient: LlmClient
}

export class QueryEngine {
  readonly sessionId: string
  readonly llmClient: LlmClient
  state: State

  constructor(params: QueryEngineParams, initialMessages?: Message[]) {
    this.sessionId = params.sessionId
    this.llmClient = params.llmClient
    this.state = {
      messages: initialMessages ?? [],
    }
  }

  static async load(params: QueryEngineParams): Promise<QueryEngine> {
    const messages = await loadMessages(params.sessionId)
    return new QueryEngine(params, messages)
  }

  async persist(): Promise<void> {
    await saveMessages(this.sessionId, this.state.messages)
  }

  async appendMessage(message: State['messages'][number]): Promise<void> {
    this.state.messages.push(message)
    await this.persist()
  }

  async appendToolResult(toolCallId: string, toolName: string, content: string): Promise<void> {
    const msg: Message = {
      uuid: newUuid(),
      role: 'tool',
      content,
      createdAt: Date.now(),
      isMeta: true,
      toolName,
      toolCallId,
    }
    this.state.messages.push(msg)
    await this.persist()
  }

  async *submitMessage(
    prompt: string | ContentBlockParam[],
    options?: { uuid?: string; isMeta?: boolean; tools?: ToolDefinition[]; signal?: AbortSignal },
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const content = toTextPrompt(prompt)
    const userUuid = options?.uuid ?? newUuid()

    const userMessage: Message = {
      uuid: userUuid,
      role: 'user',
      content,
      createdAt: Date.now(),
      isMeta: options?.isMeta ?? false,
    }

    await this.appendMessage(userMessage)

    const terminal = yield* this.queryLoop(options?.tools, options?.signal)

    if (terminal.type === 'error') {
      const errMsg = {
        uuid: newUuid(),
        role: 'assistant' as const,
        content: terminal.error,
        createdAt: Date.now(),
        isMeta: true,
      }
      await this.appendMessage(errMsg)
      yield { kind: 'message', ...errMsg }
    }
  }

  async *continueFromToolResults(tools?: ToolDefinition[], signal?: AbortSignal): AsyncGenerator<SDKMessage, void, unknown> {
    const terminal = yield* this.queryLoop(tools, signal)

    if (terminal.type === 'error') {
      const errMsg = {
        uuid: newUuid(),
        role: 'assistant' as const,
        content: terminal.error,
        createdAt: Date.now(),
        isMeta: true,
      }
      await this.appendMessage(errMsg)
      yield { kind: 'message', ...errMsg }
    }
  }

  async *queryLoop(tools?: ToolDefinition[], signal?: AbortSignal): AsyncGenerator<SDKMessage, Terminal, unknown> {
    const { state } = this
    const MAX_RETRIES = 5

    const assistantUuid = newUuid()
    const createdAt = Date.now()
    let acc = ''
    let toolCalls: LlmToolCall[] = []

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let lastError = ''
      acc = ''
      toolCalls = []

      try {
        for await (const evt of this.llmClient.streamChat(state.messages, tools, signal)) {
          if (evt.type === 'delta') {
            acc += evt.text
            yield { kind: 'delta', uuid: assistantUuid, role: 'assistant', delta: evt.text, createdAt }
            continue
          }
          if (evt.type === 'tool_calls') {
            toolCalls = evt.toolCalls
            yield { kind: 'tool_calls', toolCalls }
            continue
          }
          if (evt.type === 'error') {
            lastError = evt.error
            break
          }
          if (evt.type === 'done') {
            lastError = ''
            break
          }
        }
      } catch (e: unknown) {
        lastError = e instanceof Error ? e.message : String(e)
      }

      // 成功（无错误）
      if (!lastError) break

      // 非 429 错误或已用尽重试次数
      if (!lastError.includes('429') || attempt >= MAX_RETRIES) {
        return { type: 'error', error: lastError }
      }

      // 429 限流，等待后重试
      const waitMs = Math.min(2000 * Math.pow(2, attempt), 30000)
      yield { kind: 'delta', uuid: assistantUuid, role: 'assistant', delta: `\n[限流，${waitMs / 1000}秒后重试 (${attempt + 1}/${MAX_RETRIES})]...`, createdAt }
      await new Promise((r) => setTimeout(r, waitMs))
    }

    if (toolCalls.length > 0) {
      const toolCallMessage: Message = {
        uuid: assistantUuid,
        role: 'assistant',
        content: acc.trim() || '',
        createdAt,
        toolCalls,
      }
      await this.appendMessage(toolCallMessage)
      yield { kind: 'message', ...toolCallMessage }
      return { type: 'completed' }
    }

    if (acc.trim().length > 0) {
      const finalMessage: Message = {
        uuid: assistantUuid,
        role: 'assistant' as const,
        content: acc,
        createdAt,
      }
      await this.appendMessage(finalMessage)
      yield { kind: 'message', ...finalMessage }
    }

    return { type: 'completed' }
  }
}
