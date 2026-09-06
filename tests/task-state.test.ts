import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Orchestrator } from '../src/orchestrator/orchestrator.js'
import { applyTaskResult, beginTaskTurn, canWriteTask, pauseTask } from '../src/orchestrator/taskState.js'
import { bindTaskInput, workspaceKey } from '../src/orchestrator/taskInput.js'
import { buildRuntimeContext, buildTaskMemorySearchQuery } from '../src/orchestrator/agent.js'
import type { WorldState } from '../src/orchestrator/types.js'

function state(): WorldState { return { schemaVersion: 2, sessionId: 'unit', allowedPaths: [process.cwd()], completedTaskIds: [], failedTaskIds: [] } }
function proposal(s: WorldState) {
  const turn = beginTaskTurn(s, bindTaskInput(s, 'A'))
  applyTaskResult(s, turn, { action: 'confirm', confirmType: 'allow_write', message: 'summary', prompt: 'full exact proposal', selections: ['one', 'two'] })
  return turn
}

test('approval is version/workspace/run owned, pause disables it and explicit same-version resume restores it', () => {
  const s = state(); proposal(s)
  const confirm = bindTaskInput(s, '确认')
  const turn = beginTaskTurn(s, confirm)
  assert.equal(canWriteTask(s, turn), true)
  pauseTask(s, turn, 'cancelled')
  assert.equal(canWriteTask(s, turn), false)
  const resumed = beginTaskTurn(s, bindTaskInput(s, 'continue'))
  assert.equal(canWriteTask(s, resumed), true)
  assert.equal(canWriteTask(s, turn), false)
  s.allowedPaths = [resolve('elsewhere')]
  assert.equal(canWriteTask(s, resumed), false)
})

test('stale, duplicate and unlisted selections cannot grant permission', () => {
  const s = state(); proposal(s)
  const binding = bindTaskInput(s, '确认')
  assert.equal(binding.control?.kind, 'confirm')
  if (binding.control?.kind !== 'confirm') throw new Error('Expected confirmation')
  const control = binding.control
  assert.throws(() => beginTaskTurn(s, { ...binding, control: { ...control, selection: 'other' } }), /候选方案/)
  beginTaskTurn(s, binding)
  assert.throws(() => beginTaskTurn(s, binding), /方案/)
  const old = s.task!.id
  beginTaskTurn(s, bindTaskInput(s, 'B'))
  assert.notEqual(s.task!.id, old)
  assert.equal(s.task!.approval, undefined)
  assert.throws(() => beginTaskTurn(s, binding), /任务版本/)
})

test('constraints create a new task, answers/revise create a revision with latest objective', () => {
  const s = state(); proposal(s)
  let previous = s.task!.id
  let turn = beginTaskTurn(s, bindTaskInput(s, '确认，但只修改 package.json'))
  assert.notEqual(s.task!.id, previous)
  assert.equal(s.task!.approval, undefined)
  applyTaskResult(s, turn, { action: 'ask_user', questions: ['Which file?'] })
  previous = s.task!.id
  turn = beginTaskTurn(s, bindTaskInput(s, '可以'))
  assert.equal(s.task!.id, previous)
  assert.equal(s.task!.revision, 2)
  assert.equal(s.task!.objective, '可以')
  assert.deepEqual(s.task!.previousContext.at(-1)?.questions, ['Which file?'])
  applyTaskResult(s, turn, { action: 'confirm', prompt: 'new proposal' })
  const p = s.task!.pendingConfirmation!
  beginTaskTurn(s, bindTaskInput(s, 'only read README', { kind: 'revise', taskId: p.taskId, taskRevision: p.taskRevision, confirmationId: p.id }))
  assert.equal(s.task!.revision, 3)
  assert.equal(s.task!.objective, 'only read README')
  assert.equal(s.task!.pendingConfirmation, undefined)
})

test('cancel preserves progress, cannot resume, late done cannot complete a successor', () => {
  const s = state(); const old = proposal(s)
  s.task!.completedTaskIds.push('file-already-written')
  beginTaskTurn(s, bindTaskInput(s, 'cancel'))
  assert.deepEqual(s.task!.completedTaskIds, ['file-already-written'])
  assert.equal(s.task!.pendingConfirmation, undefined)
  assert.throws(() => bindTaskInput(s, '继续'), /继续/)
  beginTaskTurn(s, bindTaskInput(s, 'B'))
  assert.equal(applyTaskResult(s, old, { action: 'done', message: 'late' }), false)
  assert.equal(s.task!.phase, 'active')
})

test('paused proposal is redisplayed with a fresh confirmation id, directory-bound queue input rejects', () => {
  const s = state(); const turn = proposal(s)
  const id = s.task!.pendingConfirmation!.id
  pauseTask(s, turn, 'cancelled')
  beginTaskTurn(s, bindTaskInput(s, '继续'))
  assert.equal(s.task!.phase, 'awaiting_confirmation')
  assert.equal(s.task!.pendingConfirmation!.prompt, 'full exact proposal')
  assert.notEqual(s.task!.pendingConfirmation!.id, id)
  assert.equal(s.task!.approval, undefined)
  const queued = bindTaskInput(s, 'B')
  s.repository = { repoUrl: 'https://example.test/different' }
  assert.notEqual(workspaceKey(s), queued.workspaceKey)
  assert.throws(() => beginTaskTurn(s, queued), /目录或仓库/)
})

test('runtime and memory context use latest input; old goal only appears as background', () => {
  const s = state(); proposal(s)
  const turn = beginTaskTurn(s, bindTaskInput(s, 'B: read package.json'))
  const context = buildRuntimeContext(s, '', [], turn)
  assert.match(context, /本轮执行依据（最新请求，优先于历史）: B: read package.json/)
  assert.match(context, /历史\/背景/)
  assert.doesNotMatch(context, /用户目标: A/)
  assert.equal(buildTaskMemorySearchQuery(s, '?', turn), '?')
  assert.equal(buildTaskMemorySearchQuery(s, 'B: read package.json', turn), 'B: read package.json')
})

test('continue without a task is rejected without calling the runner', async () => {
  const id = `task-test-${randomUUID()}`
  let called = false
  const o = new Orchestrator(id, undefined, undefined, { run: async () => { called = true; return { action: 'chat', message: 'old' } } })
  o.state.allowedPaths = [process.cwd()]
  try {
    await assert.rejects(o.handleUserInput('继续'), /继续|resume/i)
    assert.equal(called, false)
  } finally { await rm(resolve('state', id), { recursive: true, force: true }) }
})
