import { createLlmClient } from '../llm/index.js'
import { loadModelConfig } from './modelConfig.js'
import {
  getCompressionFailureCount,
  incrementCompressionFailure,
  loadMessages,
  resetCompressionFailures,
  saveMessages,
  saveMessagesBackup,
} from '../state/sessionStore.js'
import { newUuid } from '../utils/index.js'
import { toCompressibleMessage } from './contextPolicy.js'
import type { Message } from '../types/index.js'

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000
const DEFAULT_SOFT_RATIO = 0.70
const DEFAULT_HARD_RATIO = 0.85
const DEFAULT_DANGER_RATIO = 0.95
const DEFAULT_KEEP_ROUNDS = 10
const MAX_COMPRESSION_FAILURES = 3

const COMPRESS_PROMPT = `你是上下文压缩器。按模块提取关键信息，输出结构化摘要。

模块：当前目标、已确认需求、已确认方案、文件与接口变更、用户约束、当前进度、错误与验证。

要求：
- 必须保留已有的历史压缩摘要内容，并合并进新的摘要
- 不要总结系统协议、工具规则、确认流程、运行时状态注入方式
- 保留具体文件路径、函数名、变量名等技术细节
- 丢弃闲聊、重复失败日志等非实质内容
- 总长度控制在 1200 字以内
- 没有实质内容时返回"无关键信息"`

export type ContextPressureLevel = 'normal' | 'soft' | 'hard' | 'danger'

export type ContextCompressionPolicy = {
  contextWindowTokens?: number
  softRatio?: number
  hardRatio?: number
  dangerRatio?: number
  softThresholdTokens?: number
  hardThresholdTokens?: number
  dangerThresholdTokens?: number
  keepRounds?: number
  compressor?: (oldMessages: Message[], allMessages: Message[]) => Promise<string | null>
}

export type ContextPressure = {
  tokens: number
  level: ContextPressureLevel
  thresholds: { soft: number; hard: number; danger: number }
}

function resolvePolicy(policy: ContextCompressionPolicy = {}) {
  const contextWindowTokens = policy.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS
  const soft = policy.softThresholdTokens ?? Math.floor(contextWindowTokens * (policy.softRatio ?? DEFAULT_SOFT_RATIO))
  const hard = policy.hardThresholdTokens ?? Math.floor(contextWindowTokens * (policy.hardRatio ?? DEFAULT_HARD_RATIO))
  const danger = policy.dangerThresholdTokens ?? Math.floor(contextWindowTokens * (policy.dangerRatio ?? DEFAULT_DANGER_RATIO))
  return { soft, hard, danger, keepRounds: policy.keepRounds ?? DEFAULT_KEEP_ROUNDS, compressor: policy.compressor }
}

export function estimateTokenCount(messages: Message[]): number {
  return Math.ceil(messages.reduce((total, msg) => total + msg.content.length + (msg.toolCalls ? JSON.stringify(msg.toolCalls).length : 0), 0) / 4)
}

export function getContextPressure(messages: Message[], policy: ContextCompressionPolicy = {}): ContextPressure {
  const resolved = resolvePolicy(policy)
  const tokens = estimateTokenCount(messages)
  const level: ContextPressureLevel = tokens >= resolved.danger ? 'danger'
    : tokens >= resolved.hard ? 'hard'
      : tokens >= resolved.soft ? 'soft'
        : 'normal'
  return { tokens, level, thresholds: { soft: resolved.soft, hard: resolved.hard, danger: resolved.danger } }
}

function splitByRounds(messages: Message[], keepRounds: number): [Message[], Message[]] {
  const userIndices = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'user' && !message.isMeta && !message.isCompressed)
    .map(({ index }) => index)
  if (userIndices.length <= keepRounds) return [[], messages]
  const cutoff = userIndices[userIndices.length - keepRounds]
  return [messages.slice(0, cutoff), messages.slice(cutoff)]
}

function filterQAMessages(messages: Message[]): Message[] {
  return messages.map((message) => toCompressibleMessage(message)).filter((message): message is Message => message !== null)
}

function formatMessages(messages: Message[]): string {
  return messages
    .map((message) => {
      const label = message.isCompressed ? '历史摘要' : message.role === 'user' ? '用户' : '助手'
      const content = message.content.length > 1000 ? `${message.content.slice(0, 1000)}...` : message.content
      return `[${label}]: ${content}`
    })
    .join('\n\n')
}

function buildToolUsageSummary(messages: Message[]): string {
  const counts: Record<string, number> = {}
  for (const message of messages) {
    if (message.role === 'tool' && message.toolName) counts[message.toolName] = (counts[message.toolName] || 0) + 1
  }
  return Object.entries(counts).map(([name, count]) => `${name}: ${count}次`).join(', ')
}

async function compressOldMessages(oldMessages: Message[], allMessages: Message[]): Promise<string | null> {
  const qaMessages = filterQAMessages(oldMessages)
  if (qaMessages.length === 0) return null

  const toolSummary = buildToolUsageSummary(allMessages)
  const toolContext = toolSummary ? `\n\n## 工具使用统计\n${toolSummary}` : ''
  const llmMessages: Message[] = [
    { uuid: 'compress-sys', role: 'system', content: '你是上下文压缩器。只输出压缩后的要点列表，不要输出其他内容。', createdAt: Date.now() },
    { uuid: newUuid(), role: 'user', content: `${COMPRESS_PROMPT}${toolContext}\n\n## 对话历史\n${formatMessages(qaMessages)}`, createdAt: Date.now() },
  ]

  let summary = ''
  for await (const evt of createLlmClient(await loadModelConfig('compression')).streamChat(llmMessages)) {
    if (evt.type === 'delta') summary += evt.text
    if (evt.type === 'error') return null
  }
  summary = summary.trim()
  return summary && summary !== '无关键信息' ? summary : null
}

export function buildCompressedMessages(messages: Message[], summary: string, keepRounds = DEFAULT_KEEP_ROUNDS): Message[] {
  const [, recentMessages] = splitByRounds(messages, keepRounds)
  const systemMsg = messages.find((message) => message.role === 'system')
  const next: Message[] = []
  if (systemMsg) next.push(systemMsg)
  next.push({
    uuid: newUuid(),
    role: 'user',
    content: `[压缩上下文] 以下是之前对话的关键信息摘要：\n\n${summary}`,
    createdAt: Date.now(),
    isCompressed: true,
  })
  next.push(...recentMessages.filter((message) => message.role !== 'system' && !message.isCompressed))
  return next
}

function trimLowValueOldMessages(messages: Message[], keepRounds: number): Message[] | null {
  const [oldMessages, recentMessages] = splitByRounds(messages, keepRounds)
  if (oldMessages.length === 0) return null
  const systemMsg = messages.find((message) => message.role === 'system')
  const next = [
    ...(systemMsg ? [systemMsg] : []),
    ...oldMessages.filter((message) => message.role !== 'system' && message.role !== 'tool' && !message.isMeta),
    ...recentMessages.filter((message) => message.role !== 'system'),
  ]
  return next.length < messages.length ? next : null
}

async function saveFallbackTrim(sessionId: string, messages: Message[], keepRounds: number): Promise<boolean> {
  const trimmed = trimLowValueOldMessages(messages, keepRounds)
  if (!trimmed) return false
  await saveMessagesBackup(sessionId, messages)
  await saveMessages(sessionId, trimmed)
  return true
}

export async function maybeCompressContext(sessionId: string, policy: ContextCompressionPolicy = {}): Promise<boolean> {
  const resolved = resolvePolicy(policy)
  const messages = await loadMessages(sessionId)
  if (messages.length === 0) return false

  const pressure = getContextPressure(messages, policy)
  if (pressure.level === 'normal' || pressure.level === 'soft') return false

  const failures = await getCompressionFailureCount(sessionId)
  if (failures >= MAX_COMPRESSION_FAILURES && pressure.level !== 'danger') {
    console.log(`[上下文压缩] 连续失败 ${failures} 次，跳过压缩`)
    return false
  }

  const [oldMessages] = splitByRounds(messages, resolved.keepRounds)
  const compressibleOldMessages = filterQAMessages(oldMessages)
  if (compressibleOldMessages.length === 0) return false

  try {
    const summary = await (resolved.compressor ?? compressOldMessages)(compressibleOldMessages, messages)
    if (!summary) {
      await incrementCompressionFailure(sessionId)
      return pressure.level === 'danger' ? saveFallbackTrim(sessionId, messages, resolved.keepRounds) : false
    }
    await saveMessagesBackup(sessionId, messages)
    await saveMessages(sessionId, buildCompressedMessages(messages, summary, resolved.keepRounds))
    await resetCompressionFailures(sessionId)
    return true
  } catch (err) {
    await incrementCompressionFailure(sessionId)
    console.error(`[上下文压缩] 压缩失败 (${failures + 1}/${MAX_COMPRESSION_FAILURES}):`, err)
    return pressure.level === 'danger' ? saveFallbackTrim(sessionId, messages, resolved.keepRounds) : false
  }
}
