import { randomUUID } from 'node:crypto'
import { normalizeRepositoryConfig, type AgentResult, type ConfirmationRef, type TaskRequestBinding, type TaskState, type TurnContext, type WorldState } from './types.js'
import { isCancelInput, parseTaskControl, TaskStateError, validateControlInput, workspaceKey } from './taskInput.js'
export { TaskStateError } from './taskInput.js'

export function ownsTurn(state: WorldState, turn: TurnContext): boolean {
  return state.task?.id === turn.taskId && state.task.revision === turn.taskRevision && state.task.lastRunId === turn.runId
}
export function canWriteTask(state: WorldState, turn: TurnContext): boolean {
  const task = state.task, approval = task?.approval, proposal = task?.approvedProposal
  return !!(task && approval && proposal?.allowWrite && proposal.id === approval.confirmationId
    && proposal.taskId === turn.taskId && proposal.taskRevision === turn.taskRevision
    && (proposal.selection === undefined || proposal.selections?.includes(proposal.selection))
    && task.phase === 'active' && ownsTurn(state, turn)
    && approval.taskId === turn.taskId && approval.taskRevision === turn.taskRevision
    && approval.workspaceKey === turn.workspaceKey && workspaceKey(state) === turn.workspaceKey)
}
export function requireConfirmation(state: WorldState, ref: ConfirmationRef): void {
  parseTaskControl({ taskId: ref?.taskId, taskRevision: ref?.taskRevision, confirmationId: ref?.confirmationId, kind: 'revise' })
  const task = state.task, p = task?.pendingConfirmation
  if (!p || task?.phase !== 'awaiting_confirmation' || task.id !== ref.taskId || task.revision !== ref.taskRevision || p.id !== ref.confirmationId) {
    throw new TaskStateError('stale_confirmation', '方案已改变或已确认，请重新查看当前方案')
  }
}
export function projectTask(state: WorldState): void {
  state.schemaVersion = 2
  state.goal = state.task?.objective
  state.confirmedRequirement = undefined
  state.designTasks = state.task?.designTasks
  state.completedTaskIds = [...(state.task?.completedTaskIds ?? [])]
  state.failedTaskIds = [...(state.task?.failedTaskIds ?? [])]
  state.pendingConfirm = state.task?.phase === 'awaiting_confirmation' ? state.task.pendingConfirmation : undefined
  // Legacy readers get a projection; execution never consumes this field.
  state.designConfirmed = state.task?.phase === 'active' && !!state.task.approval
}
export function beginTaskTurn(state: WorldState, binding: TaskRequestBinding): TurnContext {
  if (!binding || typeof binding.input !== 'string' || !binding.input.trim() || typeof binding.runId !== 'string' || !binding.runId || typeof binding.userMessageId !== 'string' || !binding.userMessageId) throw new TaskStateError('malformed_binding', '无效请求绑定', 400)
  if (binding.workspaceKey !== workspaceKey(state)) throw new TaskStateError('stale_workspace', '操作目录或仓库已改变，请重新发送请求')
  let task = state.task
  let intent: TurnContext['intent'] = 'new'
  const c = parseTaskControl(binding.control)
  validateControlInput(binding.input, c)
  if (c) {
    if (!task || task.id !== c.taskId || task.revision !== c.taskRevision) throw new TaskStateError('stale_task', '任务版本已改变')
    if (c.kind === 'confirm' || c.kind === 'revise') requireConfirmation(state, c)
    if (c.kind === 'confirm') {
      const p = task.pendingConfirmation!
      if (c.selection !== undefined && !p.selections?.includes(c.selection)) throw new TaskStateError('invalid_selection', '候选方案不属于当前确认', 400)
      task.approvedProposal = { ...structuredClone(p), selection: c.selection }
      task.approval = p.allowWrite ? { taskId: task.id, taskRevision: task.revision, confirmationId: p.id, workspaceKey: binding.workspaceKey } : undefined
      task.previousContext.push({ objective: task.objective, proposal: p.prompt })
      task.pendingConfirmation = undefined
      task.phase = 'active'
      intent = 'confirm'
    } else if (c.kind === 'resume') {
      if (task.phase !== 'paused' && task.phase !== 'active') throw new TaskStateError('not_resumable', '当前任务不能继续')
      if (task.approval?.workspaceKey !== binding.workspaceKey) task.approval = undefined
      if (task.pendingConfirmation) {
        const id = randomUUID()
        task.pendingConfirmation = { ...task.pendingConfirmation, id, confirmationId: id, sourceRunId: binding.runId }
        task.phase = 'awaiting_confirmation'
      } else task.phase = 'active'
      intent = 'resume'
    }
  }
  if (!c || c.kind === 'revise') {
    if (isCancelInput(binding.input) && !c) {
      if (!task) throw new TaskStateError('no_task', '当前没有可取消的任务')
      task.phase = 'cancelled'; task.approval = undefined; task.approvedProposal = undefined; task.pendingConfirmation = undefined; intent = 'cancel'
    } else {
      const revise = !!task && (c?.kind === 'revise' || task.phase === 'awaiting_input')
      const previousContext = task ? [...task.previousContext, { objective: task.objective, proposal: task.pendingConfirmation?.prompt, questions: task.questions }] : []
      task = { id: revise ? task!.id : randomUUID(), revision: revise ? task!.revision + 1 : 1,
        objective: binding.input, phase: 'active', previousContext,
        completedTaskIds: revise ? [...task!.completedTaskIds] : [], failedTaskIds: revise ? [...task!.failedTaskIds] : [], designTasks: revise ? task!.designTasks : undefined }
      intent = revise ? 'revise' : 'new'
    }
  }
  task!.lastRunId = binding.runId
  task!.interruption = undefined
  state.task = task
  projectTask(state)
  return Object.freeze({ ...binding, control: c ? Object.freeze(c) : undefined, taskId: task!.id, taskRevision: task!.revision, intent,
    allowedPaths: Object.freeze([...state.allowedPaths]) as unknown as string[], repository: Object.freeze(normalizeRepositoryConfig(state.repository)) })
}
export function applyTaskResult(state: WorldState, turn: TurnContext, result: AgentResult): boolean {
  if (!ownsTurn(state, turn)) return false
  const task = state.task!
  if (task.phase !== 'active') return false
  // An unparsed/empty response cannot preserve execution authority. Keep the
  // task and history: a transport turn ending is not proof of task completion.
  if (result.action === 'chat' && result.protocolFallback) { task.approval = undefined; task.approvedProposal = undefined }
  if (result.action === 'ask_user') { task.phase = 'awaiting_input'; task.questions = result.questions; task.approval = undefined; task.approvedProposal = undefined }
  if (result.action === 'confirm') {
    const id = randomUUID()
    task.phase = 'awaiting_confirmation'; task.approval = undefined; task.approvedProposal = undefined
    task.pendingConfirmation = { id, confirmationId: id, taskId: task.id, taskRevision: task.revision,
      kind: result.confirmType ?? 'read_only', allowWrite: result.confirmType === 'allow_write', message: result.message ?? result.prompt,
      prompt: result.prompt, selections: result.selections, sourceRunId: turn.runId }
  }
  if (result.action === 'done') { task.phase = 'completed'; task.approval = undefined; task.pendingConfirmation = undefined }
  projectTask(state)
  return true
}
export function pauseTask(state: WorldState, turn: TurnContext, reason: string): void {
  if (!ownsTurn(state, turn) || state.task?.phase === 'cancelled') return
  state.task!.phase = 'paused'; state.task!.interruption = reason; projectTask(state)
}
export function invalidateTaskWorkspace(state: WorldState): void {
  if (state.task) { state.task.approval = undefined; state.task.approvedProposal = undefined; state.task.pendingConfirmation = undefined; if (!['completed', 'cancelled'].includes(state.task.phase)) state.task.phase = 'paused' }
  projectTask(state)
}
