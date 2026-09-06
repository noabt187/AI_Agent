import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { normalizeRepositoryConfig, type TaskInputControl, type TaskRequestBinding, type WorldState } from './types.js'

export class TaskStateError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode: 400 | 409 = 409) { super(message); this.name = 'TaskStateError' }
}
export function workspaceKey(state: Pick<WorldState, 'allowedPaths' | 'repository'>): string {
  return JSON.stringify({ paths: (state.allowedPaths.length ? state.allowedPaths : [process.cwd()]).map(p => resolve(p)), repository: normalizeRepositoryConfig(state.repository) })
}
export function isPureConfirmationInput(input: string): boolean {
  return ['确认', 'confirm', '是', 'yes', 'y', 'ok', '好', '可以', '开始', '确认方案', '开始写', '开始编写'].includes(input.trim().toLowerCase())
}
export function isPureResumeInput(input: string): boolean { return ['继续', 'continue'].includes(input.trim().toLowerCase()) }
export function validateControlInput(input: string, control?: TaskInputControl): void {
  if (control?.kind === 'confirm' && !isPureConfirmationInput(input)
    && !(control.selection !== undefined && input.trim() === control.selection)) {
    throw new TaskStateError('conflicting_confirmation', '确认输入包含新约束，请作为新请求或修改方案提交', 400)
  }
  if (control?.kind === 'resume' && !isPureResumeInput(input)) {
    throw new TaskStateError('conflicting_resume', '继续输入包含新约束，请作为新请求或修改方案提交', 400)
  }
}
export function isCancelInput(input: string): boolean { return ['取消', 'cancel', '不做了'].includes(input.trim().toLowerCase()) }
export function parseTaskControl(value: unknown): TaskInputControl | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaskStateError('malformed_control', '无效控制信息', 400)
  const v = value as Record<string, unknown>
  if (!['confirm', 'revise', 'resume', 'followup'].includes(String(v.kind)) || typeof v.taskId !== 'string' || !v.taskId.trim() || !Number.isSafeInteger(v.taskRevision) || Number(v.taskRevision) < 1
    || (['confirm', 'revise'].includes(String(v.kind)) && (typeof v.confirmationId !== 'string' || !v.confirmationId.trim()))
    || (v.kind === 'followup' && (typeof v.sourceRunId !== 'string' || !v.sourceRunId.trim()))
    || (v.selection !== undefined && (v.kind !== 'confirm' || typeof v.selection !== 'string'))) {
    throw new TaskStateError('malformed_control', '无效任务版本或确认信息', 400)
  }
  return structuredClone(v) as unknown as TaskInputControl
}
export function bindTaskInput(state: WorldState, input: string, control?: unknown, ids?: { runId: string; userMessageId: string }): TaskRequestBinding {
  if (typeof input !== 'string' || !input.trim()) throw new TaskStateError('malformed_input', '输入不能为空', 400)
  if (ids && (typeof ids.runId !== 'string' || !ids.runId.trim() || typeof ids.userMessageId !== 'string' || !ids.userMessageId.trim())) throw new TaskStateError('malformed_binding', '无效运行或消息标识', 400)
  let bound = parseTaskControl(control)
  validateControlInput(input, bound)
  if (!bound && !isCancelInput(input)) {
    if (isPureResumeInput(input)) {
      if (!state.task || ['completed', 'cancelled'].includes(state.task.phase)) throw new TaskStateError('no_task', '当前没有可继续的任务')
      bound = { kind: 'resume', taskId: state.task.id, taskRevision: state.task.revision }
    } else if (isPureConfirmationInput(input)) {
      const p = state.task?.pendingConfirmation
      if (p && state.task?.phase === 'awaiting_confirmation') bound = { kind: 'confirm', taskId: p.taskId, taskRevision: p.taskRevision, confirmationId: p.id }
      else if (state.task?.phase !== 'awaiting_input') throw new TaskStateError('no_confirmation', '当前没有可确认的方案')
    }
  }
  return Object.freeze({ input, control: bound ? Object.freeze(bound) : undefined, workspaceKey: workspaceKey(state), runId: ids?.runId ?? randomUUID(), userMessageId: ids?.userMessageId ?? randomUUID() })
}
