import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadOrchestratorState, saveOrchestratorState } from '../src/state/sessionStore.js'
import { Orchestrator } from '../src/orchestrator/orchestrator.js'
import { beginTaskTurn } from '../src/orchestrator/taskState.js'
import { bindTaskInput } from '../src/orchestrator/taskInput.js'
import type { WorldState } from '../src/orchestrator/types.js'

async function fixture(fn: (id: string, path: string) => Promise<void>) {
  const id = `task-persistence-${randomUUID()}`, dir = resolve('state', id)
  await mkdir(dir, { recursive: true })
  try { await fn(id, resolve(dir, 'orchestrator-state.json')) }
  finally { await rm(dir, { recursive: true, force: true }) }
}

test('legacy BOM snapshot migrates paused with history, without authorization; backup once is exact', async () => {
  await fixture(async (id, path) => {
    const original = '\uFEFF' + JSON.stringify({ sessionId: id, allowedPaths: [], goal: 'old goal', designConfirmed: true, completedTaskIds: ['saved'], failedTaskIds: [], pendingConfirm: { allowWrite: true, message: 'short', prompt: 'complete proposal' } })
    await writeFile(path, original)
    const migrated = (await loadOrchestratorState(id))!
    assert.equal(migrated.schemaVersion, 2)
    assert.equal(migrated.task?.phase, 'paused')
    assert.equal(migrated.task?.approval, undefined)
    assert.deepEqual(migrated.task?.completedTaskIds, ['saved'])
    assert.equal(migrated.task?.pendingConfirmation?.prompt, 'complete proposal')
    await saveOrchestratorState(id, migrated)
    await saveOrchestratorState(id, migrated)
    assert.equal(await readFile(`${path}.legacy.bak`, 'utf8'), original)
    assert.equal((await loadOrchestratorState(id))?.task?.approval, undefined)
  })
})

test('missing may initialize; corrupt, future, malformed task snapshots reject and cannot be overwritten', async () => {
  await fixture(async (id, path) => {
    assert.equal(await loadOrchestratorState(id), null)
    const base: WorldState = { sessionId: id, schemaVersion: 2, allowedPaths: [], completedTaskIds: [], failedTaskIds: [] }
    beginTaskTurn(base, bindTaskInput(base, 'read'))
    for (const raw of ['{broken', JSON.stringify({ ...base, schemaVersion: 99 }), JSON.stringify({ ...base, task: { ...base.task, designTasks: 'corrupt' } })]) {
      await writeFile(path, raw)
      await assert.rejects(loadOrchestratorState(id), /状态|JSON|schema/i)
      await assert.rejects(saveOrchestratorState(id, base), /状态|JSON|schema/i)
      assert.equal(await readFile(path, 'utf8'), raw)
    }
  })
})

test('parallel snapshots serialize captured states with no leftover temporary files', async () => {
  await fixture(async (id, path) => {
    const state: WorldState = { sessionId: id, schemaVersion: 2, allowedPaths: [], completedTaskIds: [], failedTaskIds: [] }
    const saves: Promise<void>[] = []
    for (let i = 0; i < 20; i++) { beginTaskTurn(state, bindTaskInput(state, `request ${i}`)); saves.push(saveOrchestratorState(id, state)) }
    await Promise.all(saves)
    assert.equal((await loadOrchestratorState(id))?.task?.objective, 'request 19')
    assert.deepEqual(await readdir(resolve(path, '..')), ['orchestrator-state.json'])
  })
})

test('abort during terminal delivery still finalizes paused on disk', async () => {
  await fixture(async (id) => {
    const controller = new AbortController()
    const o = new Orchestrator(id, undefined, undefined, { run: async () => ({ action: 'done', message: 'done' }) })
    let snapshots = 0
    await o.handleUserInput('A', event => { if (event.type === 'task' && ++snapshots === 2) controller.abort() }, controller.signal).catch(() => {})
    const persisted = await loadOrchestratorState(id)
    assert.equal(persisted?.task?.phase, 'paused')
    assert.equal(persisted?.task?.approval, undefined)
  })
})

test('restart reconciliation disables grants for missing/mismatched/interrupted runs', async () => {
  await fixture(async (id) => {
    const o = new Orchestrator(id, undefined, undefined, { run: async () => ({ action: 'chat', message: 'working' }) })
    await o.handleUserInput('A')
    const before = o.state.task!
    before.approval = { taskId: before.id, taskRevision: before.revision, confirmationId: 'approved', workspaceKey: bindTaskInput(o.state, 'B').workspaceKey }
    await o.persist()
    const reloaded = await Orchestrator.load(id)
    await reloaded.reconcileRuns([])
    assert.equal(reloaded.state.task?.id, before.id)
    assert.equal(reloaded.state.task?.phase, 'paused')
    assert.equal(reloaded.state.task?.approval, undefined)
    assert.equal(reloaded.state.task?.interruption, 'interrupted')
  })
})
