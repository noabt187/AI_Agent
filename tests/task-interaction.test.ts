import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionDetail } from '../web/src/api.js'
import { deriveTaskInteraction } from '../web/src/taskInteraction.js'

const idle = { running: false, aborting: false, syncing: false, submitting: false }
function fixture(): SessionDetail {
  return { id: 's', running: false, messages: [{ uuid: 'm', role: 'assistant', content: '请查看回复', createdAt: 1 }],
    state: { sessionId: 's', allowedPaths: [], task: { id: 't', revision: 1, objective: '目录', phase: 'active', lastRunId: 'r', previousContext: [], completedTaskIds: [], failedTaskIds: [] } },
    runs: [{ id: 'r', sessionId: 's', prompt: '目录', status: 'completed', createdAt: 1, messageIds: ['m'], taskId: 't', taskRevision: 1, origin: 'plugin', resultMeta: { action: 'chat', protocolFallback: true } }] }
}
test('known fallback is actionable without inventing confirmation; normal and legacy chat do not auto-open', () => {
  const d = fixture()
  let v = deriveTaskInteraction(d, idle)!
  assert.equal(v.status, 'needs_attention'); assert.equal(v.confirmation, undefined)
  assert.equal(v.canFollowup, true); assert.equal(v.autoOpen, true); assert.equal(v.reply, '请查看回复')
  d.runs![0].resultMeta = { action: 'chat' }
  v = deriveTaskInteraction(d, idle)!
  assert.equal(v.status, 'turn_ended'); assert.equal(v.autoOpen, false)
  delete d.runs![0].resultMeta; delete d.runs![0].taskId
  v = deriveTaskInteraction(d, idle)!
  assert.equal(v.status, 'turn_ended'); assert.equal(v.canFollowup, false)
})
test('formal confirmation waits for terminal run and verified snapshot; stale identities cannot authorize', () => {
  const d = fixture(), task = d.state.task!
  task.phase = 'awaiting_confirmation'
  task.pendingConfirmation = { id: 'c', confirmationId: 'c', taskId: 't', taskRevision: 1, sourceRunId: 'r', prompt: '方案', message: '方案', allowWrite: true, kind: 'allow_write' }
  let v = deriveTaskInteraction(d, idle)!
  assert.equal(v.status, 'awaiting_confirmation'); assert.equal(v.confirmation?.id, 'c')
  assert.equal(v.actionable, true)
  assert.equal(deriveTaskInteraction(d, { ...idle, syncing: true })!.actionable, false)
  d.runs![0].status = 'running'; d.running = true
  v = deriveTaskInteraction(d, { ...idle, running: true })!
  assert.equal(v.status, 'running'); assert.equal(v.confirmation, undefined); assert.equal(v.canStop, true)
  d.runs![0].status = 'completed'; d.running = false; task.pendingConfirmation.taskRevision = 2
  assert.equal(deriveTaskInteraction(d, idle)!.confirmation, undefined)
})
test('active run outranks queued successor; failed/cancelled outcomes outrank earlier done', () => {
  const d = fixture()
  d.runs![0].status = 'running'; d.running = true
  d.runs!.push({ ...d.runs![0], id: 'queued', status: 'queued', createdAt: 2 })
  let v = deriveTaskInteraction(d, { ...idle, running: true })!
  assert.equal(v.run?.id, 'r'); assert.equal(v.queued, 1); assert.equal(v.status, 'running')
  d.runs!.pop(); d.running = false; d.state.task!.phase = 'completed'
  for (const [status, label] of [['failed', 'failed'], ['cancelled', 'stopped'], ['interrupted', 'interrupted'], ['completed', 'completed']] as const) {
    d.runs![0].status = status
    assert.equal(deriveTaskInteraction(d, idle)!.status, label)
  }
})
test('cross-session, stale revisions, and uncertain transport never expose task actions', () => {
  const d = fixture()
  for (const runtime of [{ ...idle, syncing: true }, { ...idle, running: true }, { ...idle, submitting: true }]) {
    assert.equal(deriveTaskInteraction(d, runtime)!.canFollowup, false)
  }
  d.runs![0].taskRevision = 99
  assert.equal(deriveTaskInteraction(d, idle)!.canFollowup, false)
  d.runs![0].sessionId = 'other'
  assert.equal(deriveTaskInteraction(d, idle)!.canFollowup, false)
  assert.equal(deriveTaskInteraction(null, idle), null)
})
