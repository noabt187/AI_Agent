import { useRef, useState } from 'react'
import { ApiError, type ConfirmationRef, type TaskInputControl } from './api'
import type { TaskInteraction } from './taskInteraction'

type Options = {
  interaction: TaskInteraction | null
  getCurrent(): TaskInteraction | null
  submit(sessionId: string, text: string, control: TaskInputControl): Promise<void>
  refresh(sessionId: string): Promise<void>
  revoke(sessionId: string, ref: ConfirmationRef): Promise<unknown>
  stop(sessionId: string, expectedRunId: string): Promise<void>
}
export function useTaskInteractionActions(options: Options) {
  const latest = useRef(options); latest.current = options
  const locks = useRef(new Set<string>())
  const [, redraw] = useState(0)
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null)
  const [completed, setCompleted] = useState<{ key: string; sessionId: string } | null>(null)
  const view = options.interaction
  async function perform(allowed: boolean, operation: (v: TaskInteraction) => Promise<unknown>): Promise<boolean> {
    if (!view || !allowed || locks.current.has(view.sessionId)) return false
    const v = view
    if (latest.current.getCurrent()?.key !== v.key) {
      setFailure({ key:v.key, message:'任务已变化，请重新查看' })
      return false
    }
    locks.current.add(v.sessionId); setFailure(null); redraw(n => n + 1)
    try {
      await operation(v)
      // A successful submission only means accepted. Refresh before dismissing.
      await latest.current.refresh(v.sessionId)
      if (latest.current.getCurrent()?.sessionId === v.sessionId) setCompleted({ key:v.key, sessionId:v.sessionId })
      return true
    } catch (error) {
      const message = error instanceof ApiError && error.status === 409
        ? '方案或运行已变化，请重新查看；没有自动重试。'
        : `${error instanceof Error ? error.message : String(error)}。已请求核实状态，请勿重复提交。`
      if (latest.current.getCurrent()?.key === v.key) setFailure({ key:v.key, message })
      try { await latest.current.refresh(v.sessionId) } catch { /* Recovery remains visible; never resend. */ }
      return false
    } finally { locks.current.delete(v.sessionId); redraw(n => n + 1) }
  }
  const ref = (v: TaskInteraction): ConfirmationRef => ({ taskId:v.confirmation!.taskId, taskRevision:v.confirmation!.taskRevision, confirmationId:v.confirmation!.id })
  const revise = (text: string) => perform(!!view?.confirmation && !!text.trim(), v => latest.current.submit(v.sessionId,
    `请根据以下意见重新整理当前待确认方案，本轮不执行修改：\n\n${text.trim()}`, { kind:'revise', ...ref(v) }))
  const followup = (text: string) => perform(!!view?.canFollowup && !!text.trim(), v => latest.current.submit(v.sessionId, text.trim(),
    { kind:'followup', taskId:v.task!.id, taskRevision:v.task!.revision, sourceRunId:v.run!.id }))
  return {
    busy: !!view && locks.current.has(view.sessionId),
    error: failure?.key === view?.key ? failure?.message ?? '' : '', completed,
    confirm: (selection?: string) => perform(!!view?.confirmation && (!selection || !!view.confirmation.selections?.includes(selection)), v =>
      latest.current.submit(v.sessionId, '确认', { kind:'confirm', ...ref(v), ...(selection ? { selection } : {}) })),
    revoke: () => perform(!!view?.confirmation, v => latest.current.revoke(v.sessionId, ref(v))),
    revise, followup,
    compare: () => revise('请对比候选方案的优缺点、适用场景与推荐选择，然后重新给出待确认方案。'),
    replan: () => followup('请根据当前任务、上一轮问题和回复重新整理可确认的方案，返回正式的 confirm；信息不足则 ask_user。本轮只整理方案，不修改文件、不执行生成，也不沿用旧写权限。'),
    resume: () => perform(!!view?.canResume, v => latest.current.submit(v.sessionId, '继续', { kind:'resume', taskId:v.task!.id, taskRevision:v.task!.revision })),
    stop: () => perform(!!view?.canStop, v => latest.current.stop(v.sessionId, v.run!.id)),
  }
}
export type TaskInteractionActions = ReturnType<typeof useTaskInteractionActions>
