import type { RunRecord, SessionDetail, TaskState } from './api'
import { partialOutputText } from './sessionTimeline'

export type InteractionRuntime = { running: boolean; aborting: boolean; syncing: boolean; submitting: boolean }
const labels = {
  submitting: '正在提交', queued: '已排队', running: '正在执行', stopping: '正在停止',
  awaiting_confirmation: '等待确认', awaiting_input: '等待补充信息', failed: '执行失败',
  interrupted: '运行中断', stopped: '已停止', paused: '任务已暂停', turn_ended: '本轮已结束',
  needs_attention: 'Agent 已回复，但未返回有效任务指令', completed: '任务已完成',
  cancelled: '任务已取消', syncing: '正在核实状态',
} as const
export type TaskInteraction = {
  key: string; sessionId: string; status: keyof typeof labels; label: string
  origin: 'composer' | 'plugin'; run?: RunRecord; task?: TaskState
  confirmation?: TaskState['pendingConfirmation']; reply: string; queued: number
  actionable: boolean; autoOpen: boolean; canFollowup: boolean; canResume: boolean; canStop: boolean
}

/** A projection, never an execution state machine. A finished HTTP/run is not a finished task. */
export function deriveTaskInteraction(detail: SessionDetail | null, runtime: InteractionRuntime): TaskInteraction | null {
  if (!detail) return null
  const task = detail.state.task
  const runs = (detail.runs ?? []).filter(r => r.sessionId === detail.id)
  const active = runs.filter(r => r.status === 'running')
  const queued = runs.filter(r => r.status === 'queued')
  const source = runs.find(r => r.id === task?.lastRunId)
  const run = active[0] ?? queued[0] ?? source ?? [...runs].sort((a, b) => b.createdAt - a.createdAt)[0]
  if (!task && !run && !runtime.submitting && !runtime.syncing) return null
  const owned = !!task && !!run && task.lastRunId === run.id && run.taskId === task.id && run.taskRevision === task.revision
  const terminal = !!run && !['queued', 'running'].includes(run.status)
  const uncertain = runtime.syncing || active.length > 1 || (runtime.running && !active.length && !queued.length && !runtime.submitting)
  const settled = !uncertain && !runtime.running && !detail.running && !runtime.submitting && !active.length && !queued.length && terminal
  const p = task?.pendingConfirmation
  const confirmation = settled && owned && task?.phase === 'awaiting_confirmation' && run?.status === 'completed'
    && p?.taskId === task.id && p.taskRevision === task.revision && p.sourceRunId === run.id ? p : undefined
  let status: TaskInteraction['status']
  if (uncertain) status = 'syncing'
  else if (active.length) status = runtime.aborting ? 'stopping' : 'running'
  else if (queued.length) status = 'queued'
  else if (runtime.submitting) status = 'submitting'
  else if (detail.running) status = 'syncing'
  else if (run?.status === 'failed') status = 'failed'
  else if (run?.status === 'interrupted') status = 'interrupted'
  else if (run?.status === 'cancelled') status = 'stopped'
  else if (task?.phase === 'cancelled') status = 'cancelled'
  else if (task?.phase === 'paused') status = 'paused'
  else if (confirmation) status = 'awaiting_confirmation'
  else if (owned && task?.phase === 'awaiting_input') status = 'awaiting_input'
  else if (owned && task?.phase === 'completed' && run?.status === 'completed') status = 'completed'
  else if (owned && task?.phase === 'active' && run?.resultMeta?.protocolFallback) status = 'needs_attention'
  else status = 'turn_ended'
  const canFollowup = settled && owned && (task?.phase === 'active' || task?.phase === 'awaiting_input')
  const canResume = settled && owned && task?.phase === 'paused'
  const actionable = !!confirmation || (canFollowup && ['awaiting_input', 'needs_attention'].includes(status))
  const reply = detail.messages.filter(m => run?.messageIds.includes(m.uuid) && m.role === 'assistant' && !m.isMeta).map(m => m.content).join('\n\n')
    || (run?.partialOutput ? partialOutputText(run.partialOutput) : '')
  return { key: JSON.stringify([detail.id, task?.id, task?.revision, confirmation?.id ?? run?.id, status]),
    sessionId: detail.id, status, label: labels[status], origin: run?.origin ?? 'composer', run, task,
    confirmation, reply, queued: queued.length, actionable, autoOpen: actionable,
    canFollowup, canResume, canStop: status === 'running' && active.length === 1 && !runtime.aborting }
}
