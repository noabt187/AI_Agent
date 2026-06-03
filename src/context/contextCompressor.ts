import { createLlmClient } from '../llm/index.js'
import { loadModelConfig } from './modelConfig.js'
import { loadMessages, saveMessages, saveMessagesBackup, getCompressionFailureCount, incrementCompressionFailure, resetCompressionFailures } from '../state/sessionStore.js'
import { newUuid } from '../utils/index.js'
import type { Message } from '../types/index.js'

const COMPRESSION_THRESHOLD = 50_000 // tokens
const KEEP_ROUNDS = 10

const COMPRESS_PROMPT = `你是上下文压缩器。以下是之前的对话历史。

## 任务
从对话历史中提取关键信息，用结构化格式输出。

## 输出格式
用以下分类组织信息（没有则跳过该分类）：

### 用户需求
- 用户提出的核心需求和目标

### 技术决策
- 做出的技术选型、架构决策

### 文件变更
- 涉及的文件路径和修改内容

### 约束与偏好
- 用户明确的约束条件、编码偏好

### 当前进度
- 已完成的工作、待完成的任务

## 要求
- 保留具体文件路径、函数名、变量名等技术细节
- 保留用户明确表达的偏好和约束
- 丢弃问候、闲聊、错误重试等非实质内容
- 总长度控制在 1000 字以内
- 如果对话中没有实质性内容，返回"无关键信息"`

// ── Token Estimation ──────────────────────────────────────────────────

export function estimateTokenCount(messages: Message[]): number {
  let totalChars = 0
  for (const msg of messages) {
    totalChars += msg.content.length
  }
  return Math.ceil(totalChars / 4)
}

// ── Round Splitting ───────────────────────────────────────────────────

function splitByRounds(messages: Message[], keepRounds: number): [Message[], Message[]] {
  // A "round" starts with a real user message (not meta, not compressed)
  const userIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'user' && !m.isMeta && !m.isCompressed) {
      userIndices.push(i)
    }
  }

  if (userIndices.length <= keepRounds) return [[], messages]

  const cutoffIndex = userIndices[userIndices.length - keepRounds]
  return [messages.slice(0, cutoffIndex), messages.slice(cutoffIndex)]
}

// ── Message Filtering for Compression ─────────────────────────────────

function filterQAMessages(messages: Message[]): Message[] {
  return messages.filter((m) => {
    if (m.role === 'system') return false
    if (m.role === 'tool') return false
    if (m.isMeta) return false
    if (m.isCompressed) return false
    if (m.role === 'user' && m.content.startsWith('工具执行结果')) return false
    if (m.role === 'assistant') {
      const trimmed = m.content.trim()
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const parsed = JSON.parse(trimmed)
          if (parsed.toolCalls) return false
        } catch {}
      }
    }
    return true
  })
}

function formatMessages(messages: Message[]): string {
  return messages
    .map((m) => {
      const label = m.role === 'user' ? '用户' : '助手'
      const content = m.content.length > 1000 ? m.content.slice(0, 1000) + '...' : m.content
      return `[${label}]: ${content}`
    })
    .join('\n\n')
}

function buildToolUsageSummary(messages: Message[]): string {
  const toolMessages = messages.filter((m) => m.role === 'tool' && m.toolName)
  if (toolMessages.length === 0) return ''
  const toolCalls: Record<string, number> = {}
  for (const m of toolMessages) {
    toolCalls[m.toolName!] = (toolCalls[m.toolName!] || 0) + 1
  }
  return Object.entries(toolCalls)
    .map(([name, count]) => `${name}: ${count}次`)
    .join(', ')
}

// ── Compress Old Messages ─────────────────────────────────────────────

async function compressOldMessages(oldMessages: Message[], allMessages?: Message[]): Promise<string | null> {
  const qaMessages = filterQAMessages(oldMessages)
  if (qaMessages.length === 0) return null

  const rawMessages = formatMessages(qaMessages)
  const cfg = await loadModelConfig()
  const llm = createLlmClient(cfg)

  const toolSummary = allMessages ? buildToolUsageSummary(allMessages) : ''
  const toolContext = toolSummary ? `\n\n## 工具使用统计\n${toolSummary}` : ''
  const prompt = `${COMPRESS_PROMPT}${toolContext}\n\n## 对话历史\n${rawMessages}`

  const llmMessages: Message[] = [
    { uuid: 'compress-sys', role: 'system', content: '你是上下文压缩器。只输出压缩后的要点列表，不要输出其他内容。', createdAt: Date.now() },
    { uuid: newUuid(), role: 'user', content: prompt, createdAt: Date.now() },
  ]

  let summary = ''
  for await (const evt of llm.streamChat(llmMessages)) {
    if (evt.type === 'delta') {
      summary += evt.text
    } else if (evt.type === 'error') {
      return null
    }
  }

  summary = summary.trim()
  if (!summary || summary === '无关键信息') return null
  return summary
}

// ── Main Entry Point ──────────────────────────────────────────────────

const MAX_COMPRESSION_FAILURES = 3

export async function maybeCompressContext(
  sessionId: string,
  threshold: number = COMPRESSION_THRESHOLD,
  keepRounds: number = KEEP_ROUNDS,
): Promise<boolean> {
  // Circuit breaker: skip if too many consecutive failures
  const failures = await getCompressionFailureCount(sessionId)
  if (failures >= MAX_COMPRESSION_FAILURES) {
    console.log(`[上下文压缩] 连续失败 ${failures} 次，跳过压缩`)
    return false
  }

  const messages = await loadMessages(sessionId)
  if (messages.length === 0) return false

  const tokens = estimateTokenCount(messages)
  if (tokens < threshold) return false

  const [oldMessages, recentMessages] = splitByRounds(messages, keepRounds)
  if (oldMessages.length === 0) return false

  try {
    const summary = await compressOldMessages(oldMessages, messages)
    if (!summary) return false

    // Backup full history before compression
    await saveMessagesBackup(sessionId, messages)

    // Build new messages: system + compressed context + recent
    const systemMsg = messages.find((m) => m.role === 'system')
    const newMessages: Message[] = []

    if (systemMsg) {
      newMessages.push(systemMsg)
    }

    newMessages.push({
      uuid: newUuid(),
      role: 'user',
      content: `[压缩上下文] 以下是之前对话的关键信息摘要：\n\n${summary}`,
      createdAt: Date.now(),
      isCompressed: true,
    })

    for (const msg of recentMessages) {
      if (msg.role === 'system') continue
      if (msg.isCompressed) continue // replace old compressed context
      newMessages.push(msg)
    }

    await saveMessages(sessionId, newMessages)
    await resetCompressionFailures(sessionId)
    return true
  } catch (err) {
    await incrementCompressionFailure(sessionId)
    console.error(`[上下文压缩] 压缩失败 (${failures + 1}/${MAX_COMPRESSION_FAILURES}):`, err)
    return false
  }
}
