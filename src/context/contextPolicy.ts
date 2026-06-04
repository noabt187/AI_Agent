import type { Message } from '../types/index.js'

const TRANSIENT_CONTEXT_START = '[本轮临时上下文]'
const USER_INPUT_MARKER = '[用户输入]'

const EXCLUDED_LINES = [
  /^\s*\[本轮临时上下文\]/,
  /^\s*##\s*当前状态/,
  /^\s*##\s*相关项目记忆/,
  /^\s*##\s*相关历史任务记忆/,
  /^\s*可操作目录[:：]/,
  /^\s*待确认内容[:：]/,
  /^\s*工具执行结果[:：]/,
  /错误[:：]当前未确认方案/,
  /用户拒绝了此操作/,
  /请先向用户确认修改方案后再修改代码/,
]

const GENERIC_TERMS = new Set([
  '前端', '后端', '代码', '修改', '功能', '需求', '任务', '用户', '页面', '组件',
  '错误', '报错', '不会', '处理', '验证', '测试', '运行', '项目', '文件', '实现', '修复',
  'frontend', 'backend', 'src', 'test', 'tests', 'npm',
])

export function stripTransientRuntimeContext(content: string): string {
  const trimmed = content.trimStart()
  if (!trimmed.startsWith(TRANSIENT_CONTEXT_START)) return content
  const markerIndex = trimmed.indexOf(USER_INPUT_MARKER)
  return markerIndex === -1 ? '' : trimmed.slice(markerIndex + USER_INPUT_MARKER.length).trim()
}

export function sanitizeTranscriptContent(content: string): string {
  return stripTransientRuntimeContext(content)
    .split('\n')
    .filter((line) => !EXCLUDED_LINES.some((pattern) => pattern.test(line)))
    .join('\n')
    .trim()
}

export function filterGenericSearchTerms(terms: string[]): string[] {
  return terms.filter((term) => {
    const normalized = term.trim().toLowerCase()
    return normalized.length >= 2 && !GENERIC_TERMS.has(normalized)
  })
}

export function toCompressibleMessage(message: Message): Message | null {
  if (message.role === 'system' || message.role === 'tool' || message.isMeta) return null
  if (message.role === 'user' && message.content.startsWith('工具执行结果')) return null
  const content = sanitizeTranscriptContent(message.content)
  if (!content && !message.isCompressed) return null
  return { ...message, content }
}
