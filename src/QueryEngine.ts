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

type QueryEngineParams = {
  sessionId: string
  llmClient: LlmClient
}

export class QueryTerminalError extends Error {
  constructor(message: string) { super(message); this.name = 'QueryTerminalError' }
}

function withRuntimeContext(messages: Message[], runtimeContext?: string): Message[] {
  const trimmedContext = runtimeContext?.trim()
  if (!trimmedContext) return messages

  const requestMessages = messages.map((m) => ({ ...m }))
  for (let i = requestMessages.length - 1; i >= 0; i--) {
    const msg = requestMessages[i]
    if (msg.role === 'user' && !msg.isMeta && !msg.isCompressed) {
      msg.content = `[本轮临时上下文]\n${trimmedContext}\n\n[用户输入]\n${msg.content}`
      return requestMessages
    }
  }

  return requestMessages
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
    options?: { uuid?: string; isMeta?: boolean; tools?: ToolDefinition[]; signal?: AbortSignal; runtimeContext?: string },
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

    // Queue admission can persist the real user message before execution.
    const existing = this.state.messages.find(message => message.uuid === userUuid)
    if (existing) {
      if (existing.role !== 'user' || existing.content !== content || !!existing.isMeta !== userMessage.isMeta) throw new Error('User message UUID binding mismatch')
    } else await this.appendMessage(userMessage)

    const terminal = yield* this.queryLoop(options?.tools, options?.signal, options?.runtimeContext)

    if (terminal.type === 'error') {
      const isAbort = terminal.aborted === true
      const errMsg: Message = {
        uuid: newUuid(),
        role: isAbort ? 'tool' : 'assistant',
        content: terminal.error,
        createdAt: Date.now(),
        isMeta: true,
      }
      if (isAbort) errMsg.toolName = 'abort'
      await this.appendMessage(errMsg)
      yield { kind: 'message', ...errMsg }
      if (!isAbort) throw new QueryTerminalError(terminal.error)
    }
  }

  async *continueFromToolResults(tools?: ToolDefinition[], signal?: AbortSignal, runtimeContext?: string): AsyncGenerator<SDKMessage, void, unknown> {
    const terminal = yield* this.queryLoop(tools, signal, runtimeContext)

    if (terminal.type === 'error') {
      const isAbort = terminal.aborted === true
      const errMsg: Message = {
        uuid: newUuid(),
        role: isAbort ? 'tool' : 'assistant',
        content: terminal.error,
        createdAt: Date.now(),
        isMeta: true,
      }
      if (isAbort) errMsg.toolName = 'abort'
      await this.appendMessage(errMsg)
      yield { kind: 'message', ...errMsg }
      if (!isAbort) throw new QueryTerminalError(terminal.error)
    }
  }

  async *queryLoop(tools?: ToolDefinition[], signal?: AbortSignal, runtimeContext?: string): AsyncGenerator<SDKMessage, Terminal, unknown> {
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
        for await (const evt of this.llmClient.streamChat(withRuntimeContext(state.messages, runtimeContext), tools, signal)) {
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
        if (signal?.aborted) {
          return { type: 'error', error: '操作已取消', aborted: true }
        }
        lastError = e instanceof Error ? e.message : String(e)
      }

      // 成功（无错误）
      if (!lastError) break

      // 429 限流 + 5xx 服务端错误 → 可重试；其他错误直接返回
      const isRetryable = /HTTP (429|5\d{2})/.test(lastError) || lastError.includes('429')
      if (!isRetryable || attempt >= MAX_RETRIES) {
        return { type: 'error', error: lastError }
      }

      // 等待后重试（指数退避）
      const waitMs = Math.min(2000 * Math.pow(2, attempt), 30000)
      const reason = lastError.includes('429') ? '限流' : '服务端错误'
      yield {
        kind: 'retry',
        attempt: attempt + 1,
        maxAttempts: MAX_RETRIES,
        reason,
        delayMs: waitMs,
      }
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
