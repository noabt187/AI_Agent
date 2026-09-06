import type { Message, RunRecord } from './api'
import { messageContent } from './messageContent'

export type TimelineItem = { id: string; role: 'user' | 'assistant' | 'activity' | 'error'; content: string }
const runLabels = { queued: '请求排队中', running: '正在执行', completed: '执行完成', failed: '执行失败', cancelled: '操作已取消', interrupted: '运行意外中断（服务重启）' }

export function partialOutputText(raw: string): string {
  if (!raw.trimStart().startsWith('{')) return raw
  // Only recover user-visible fields from a partial structured model response.
  const match = /"(?:message|prompt)"\s*:\s*"((?:\\.|[^"\\])*)/.exec(raw)
  if (!match) return ''
  try { return JSON.parse(`"${match[1]}"`) as string } catch { return match[1].replace(/\\n/g, '\n') }
}

export function sessionTimeline(messages: Message[], runs: RunRecord[] = []): TimelineItem[] {
  const items = messages.filter(m => !m.isMeta && m.role !== 'system' && m.role !== 'tool')
    .map(m => ({ id: m.uuid, role: m.role === 'user' ? 'user' as const : 'assistant' as const, content: messageContent(m).trim(), time: m.createdAt }))
    .filter(m => m.content)
  const additions = new Map<number, TimelineItem[]>()
  for (const run of runs) {
    const owned = items.filter(item => run.messageIds.includes(item.id) || item.id === run.userMessageId)
    const anchor = owned.length ? items.indexOf(owned[owned.length - 1]) : items.reduce((last, item, index) => item.time <= run.createdAt ? index : last, -1)
    const extra = additions.get(anchor) ?? []
    if (!owned.some(item => item.role === 'user')) extra.push({ id: run.userMessageId || `${run.id}:prompt`, role: 'user', content: run.prompt })
    const partial = partialOutputText(run.partialOutput ?? '').trim()
    if (partial && run.status !== 'completed' && !owned.some(item => item.role === 'assistant' && item.content.includes(partial))) {
      extra.push({ id: `${run.id}:partial`, role: 'assistant', content: partial })
    }
    extra.push({ id: `${run.id}:status`, role: 'activity', content: `${runLabels[run.status]}${run.status === 'failed' && run.error ? `：${run.error}` : ''}` })
    additions.set(anchor, extra)
  }
  const result: TimelineItem[] = [...(additions.get(-1) ?? [])]
  items.forEach((item, index) => { result.push(item, ...(additions.get(index) ?? [])) })
  return result
}
