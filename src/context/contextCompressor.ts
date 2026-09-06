import { createLlmClient } from '../llm/index.js'
import { loadModelConfig } from './modelConfig.js'
import { loadMessages, saveMessages, saveMessagesBackup, getCompressionFailureCount, incrementCompressionFailure, resetCompressionFailures } from '../state/sessionStore.js'
import { newUuid } from '../utils/index.js'
import type { Message } from '../types/index.js'

const COMPRESSION_THRESHOLD = 50_000 // tokens
const KEEP_ROUNDS = 10

const COMPRESS_PROMPT = `你是上下文压缩器。将对话历史压缩为结构化摘要，用于后续会话恢复。被压缩的任务都已完成，不要在摘要中保留待执行指令。

## 输出格式

严格按以下模板输出，没有内容的分类标注"无"即可：

### 1. 核心任务
用户的目标和意图（1-3句话概括主线）；已完成的任务用"✅"标记。

### 2. 技术概念
对话中涉及的技术要点列表：框架、库、架构模式、API、数据结构等。每项一行。

### 3. 文件变更
每个被修改的文件单独一条，格式：
file_path — 做了什么改动（不存代码diff，存改动描述和原因）
只列出最终状态的变更，中间试错的改动不记。

### 4. 错误与修复
遇到的错误 + 修复方式。严重错误标注【严重】。格式：
【严重】错误描述 → 根因 → 修复方式

### 5. 未完成任务
明确标记为待处理的任务（没有则写"无"）。

### 6. 当前工作
压缩前正在做什么——写够细，让恢复后能直接继续。包含正在改的文件名和具体操作。

### 7. 用户偏好与约束
用户明确表达的编码偏好、工作流约束、沟通偏好。

## 要求
- 文件路径必须完整，包含相对于项目根目录的路径
- 保留函数名、变量名、类名等具体标识符
- 丢弃问候、闲聊、纯确认词（"好的""确认""是"）、错误重试循环
- 同一事实只记一次，不重复
- 避免模糊表述如"做了一些修改"，改为"在 Agent.run() 的 for-await 循环前添加 signal?.aborted 检查"
- 总长度控制在 2000 字以内
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

async function compressOldMessages(oldMessages: Message[], allMessages?: Message[], signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted()
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
  for await (const evt of llm.streamChat(llmMessages, undefined, signal)) {
    signal?.throwIfAborted()
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
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted()
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
    const summary = await compressOldMessages(oldMessages, messages, signal)
    signal?.throwIfAborted()
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
      content: `[压缩上下文] 以下是之前对话的关键信息摘要。摘要中描述的任务均已完成——不要重复执行、不要重新生成代码，仅用于理解对话背景。涉及文件、接口或组件状态时，需读取当前项目确认。

${summary}`,
      createdAt: Date.now(),
      isCompressed: true,
    })

    for (const msg of recentMessages) {
      if (msg.role === 'system') continue
      if (msg.isCompressed) continue // replace old compressed context
      newMessages.push(msg)
    }

    signal?.throwIfAborted()
    await saveMessages(sessionId, newMessages)
    await resetCompressionFailures(sessionId)
    return true
  } catch (err) {
    signal?.throwIfAborted()
    await incrementCompressionFailure(sessionId)
    console.error(`[上下文压缩] 压缩失败 (${failures + 1}/${MAX_COMPRESSION_FAILURES}):`, err)
    return false
  }
}
