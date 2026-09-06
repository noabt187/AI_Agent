import { randomUUID } from 'node:crypto'
import type { RunRecord } from '../state/runStore.js'
import type { TaskState, WorldState } from './types.js'
import { normalizeMemorySettings, normalizeRepositoryConfig } from './types.js'
import { projectTask } from './taskState.js'

function fail(): never { throw new Error('无效的任务状态 schema') }
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string')
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export function normalizeTaskState(value: unknown): WorldState {
  if (!object(value) || typeof value.sessionId !== 'string' || !strings(value.allowedPaths)) fail()
  if (value.schemaVersion !== undefined && value.schemaVersion !== 2) fail()
  const state = structuredClone(value) as WorldState
  if (value.schemaVersion === 2 && value.task !== undefined) {
    const t = value.task
    if (!object(t) || typeof t.id !== 'string' || !t.id || !Number.isSafeInteger(t.revision) || Number(t.revision) < 1
      || typeof t.objective !== 'string' || !['active', 'awaiting_input', 'awaiting_confirmation', 'paused', 'completed', 'cancelled'].includes(String(t.phase))
      || !Array.isArray(t.previousContext) || !t.previousContext.every(c => object(c) && typeof c.objective === 'string' && (c.proposal === undefined || typeof c.proposal === 'string') && (c.requirement === undefined || typeof c.requirement === 'string') && (c.questions === undefined || strings(c.questions)))
      || !strings(t.completedTaskIds) || !strings(t.failedTaskIds) || (t.lastRunId !== undefined && typeof t.lastRunId !== 'string')
      || (t.questions !== undefined && !strings(t.questions))
      || (t.designTasks !== undefined && (!Array.isArray(t.designTasks) || !t.designTasks.every(d => object(d) && typeof d.id === 'string' && typeof d.title === 'string' && typeof d.description === 'string' && typeof d.file === 'string' && ['create', 'modify', 'delete'].includes(String(d.changeType)) && strings(d.dependencies) && typeof d.rationale === 'string')))) fail()
    if (t.pendingConfirmation !== undefined) {
      const p = t.pendingConfirmation
      if (!['paused', 'awaiting_confirmation'].includes(String(t.phase)) || !object(p) || typeof p.id !== 'string' || !p.id || p.id !== p.confirmationId || p.taskId !== t.id || p.taskRevision !== t.revision
        || typeof p.prompt !== 'string' || typeof p.message !== 'string' || typeof p.sourceRunId !== 'string'
        || !['allow_write', 'read_only'].includes(String(p.kind)) || p.allowWrite !== (p.kind === 'allow_write')
        || (p.selections !== undefined && !strings(p.selections))) fail()
    }
    if (t.phase === 'awaiting_confirmation' && !t.pendingConfirmation) fail()
    if (t.approvedProposal !== undefined) {
      const p = t.approvedProposal
      if (!object(p) || typeof p.id !== 'string' || !p.id || p.id !== p.confirmationId || p.taskId !== t.id || p.taskRevision !== t.revision
        || typeof p.prompt !== 'string' || typeof p.message !== 'string' || typeof p.sourceRunId !== 'string'
        || !['allow_write', 'read_only'].includes(String(p.kind)) || p.allowWrite !== (p.kind === 'allow_write')
        || (p.selections !== undefined && !strings(p.selections))
        || (p.selection !== undefined && (typeof p.selection !== 'string' || !strings(p.selections) || !p.selections.includes(p.selection)))) fail()
    }
    if (t.approval !== undefined) {
      const a = t.approval
      if (!object(a) || a.taskId !== t.id || a.taskRevision !== t.revision || typeof a.confirmationId !== 'string' || !a.confirmationId || typeof a.workspaceKey !== 'string'
        || !['active', 'paused'].includes(String(t.phase)) || t.pendingConfirmation) fail()
      const p = t.approvedProposal
      if (p === undefined) {
        // Early v2 snapshots did not retain which alternative was approved.
        // Their grants cannot safely recover an exact approved proposal.
        state.task!.approval = undefined
      } else if (!object(p) || p.allowWrite !== true || p.id !== a.confirmationId) fail()
    }
  } else if (value.schemaVersion === undefined) {
    // Unversioned permissions are background only, never executable grants.
    state.task = undefined
    if (value.goal || value.confirmedRequirement || value.pendingConfirm || value.designTasks) {
      const oldPending = object(value.pendingConfirm) ? value.pendingConfirm : undefined
      state.task = { id: randomUUID(), revision: 1, objective: String(value.goal || value.confirmedRequirement || '旧任务'), phase: 'paused',
        previousContext: [{ objective: String(value.goal || ''), requirement: typeof value.confirmedRequirement === 'string' ? value.confirmedRequirement : undefined,
          proposal: typeof oldPending?.prompt === 'string' ? oldPending.prompt : typeof oldPending?.message === 'string' ? oldPending.message : undefined }],
        completedTaskIds: strings(value.completedTaskIds) ? value.completedTaskIds : [], failedTaskIds: strings(value.failedTaskIds) ? value.failedTaskIds : [],
        designTasks: Array.isArray(value.designTasks) ? value.designTasks as TaskState['designTasks'] : undefined }
      if (oldPending) {
        const id = randomUUID()
        state.task.pendingConfirmation = { id, confirmationId: id, taskId: state.task.id, taskRevision: 1,
          kind: oldPending.allowWrite ? 'allow_write' : 'read_only', allowWrite: !!oldPending.allowWrite,
          message: String(oldPending.message ?? ''), prompt: String(oldPending.prompt ?? oldPending.message ?? ''), sourceRunId: 'legacy' }
      }
    }
  }
  state.memorySettings = normalizeMemorySettings(state.memorySettings)
  state.repository = normalizeRepositoryConfig(state.repository)
  projectTask(state)
  return state
}

export function reconcileTaskRuns(state: WorldState, records: RunRecord[]): boolean {
  const t = state.task
  if (!t || ['completed', 'cancelled'].includes(t.phase)) return false
  const run = records.find(r => r.id === t.lastRunId)
  // CLI and HTTP turns both require a durable matching outcome to recover grants.
  const identity = run as (RunRecord & { taskId?: string; taskRevision?: number }) | undefined
  const consistent = run && run.sessionId === state.sessionId && identity?.taskId === t.id && identity.taskRevision === t.revision
  const resumableStop = consistent && run.status === 'cancelled' && t.phase === 'paused'
  if (resumableStop || (consistent && run.status === 'completed')) return false
  t.phase = 'paused'; t.approval = undefined; t.interruption = 'interrupted'
  projectTask(state)
  return true
}
