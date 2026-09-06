import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Orchestrator } from '../src/orchestrator/orchestrator.js'
import type { WorldState } from '../src/orchestrator/types.js'
import { normalizeMemorySettings } from '../src/orchestrator/types.js'
import { executeToolResult, toolDefsToOpenAI } from '../src/tools/index.js'
import { applyTaskResult, beginTaskTurn, canWriteTask } from '../src/orchestrator/taskState.js'

function state(sessionId: string): WorldState {
  return {
    sessionId,
    allowedPaths: [],
    memorySettings: normalizeMemorySettings(),
    completedTaskIds: [],
    failedTaskIds: [],
    designConfirmed: false,
  }
}

test('read schema hides every side-effect tool', () => {
  const readNames = new Set(toolDefsToOpenAI('read').map((item) => item.function.name))
  const allNames = new Set(toolDefsToOpenAI('write').map((item) => item.function.name))

  assert.ok(readNames.has('readTextFile'))
  for (const name of ['writeFile', 'deleteFile', 'verifyCode', 'createPullRequest', 'forkRepository', 'cloneRepository', 'saveCheckpoint']) {
    assert.ok(!readNames.has(name), `${name} must require confirmation`)
    assert.ok(allNames.has(name), `${name} must remain registered`)
  }
})

test('execution gate rejects writes and command execution before confirmation', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-permission-'))
  const filePath = resolve(rootDir, 'blocked.txt')
  const write = await executeToolResult('writeFile', { filePath, content: 'blocked' }, [rootDir], false)
  const verify = await executeToolResult('verifyCode', { rootDir, changedFiles: '' }, [rootDir], false)

  assert.equal(write.code, 'PERMISSION_DENIED')
  assert.equal(verify.code, 'PERMISSION_DENIED')
  await assert.rejects(readFile(filePath, 'utf8'), /ENOENT/)
})

test('execution gate allows a confirmed write', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-permission-'))
  const filePath = resolve(rootDir, 'allowed.txt')
  const write = await executeToolResult('writeFile', { filePath, content: 'allowed' }, [rootDir], true)

  assert.equal(write.ok, true)
  assert.equal(await readFile(filePath, 'utf8'), 'allowed')
})

test('protocol fallback and done revoke grants without erasing the revision-bound task history', () => {
  for (const result of [
    { action: 'chat', message: 'unparsed fallback', protocolFallback: true } as const,
    { action: 'done', message: '修改完成' } as const,
  ]) {
    const orchestrator = new Orchestrator('permission-reset', state('permission-reset'))
    const initial = beginTaskTurn(orchestrator.state, orchestrator.bindInput('test goal'))
    applyTaskResult(orchestrator.state, initial, { action: 'confirm', prompt: 'write only this task', confirmType: 'allow_write' })
    const confirmed = beginTaskTurn(orchestrator.state, orchestrator.bindInput('确认'))
    assert.equal(canWriteTask(orchestrator.state, confirmed), true)
    applyTaskResult(orchestrator.state, confirmed, result)
    assert.equal(canWriteTask(orchestrator.state, confirmed), false)
    assert.equal(orchestrator.state.designConfirmed, false)
    assert.equal(orchestrator.state.pendingConfirm, undefined)
    assert.equal(orchestrator.state.task?.objective, 'test goal')
    assert.equal(orchestrator.state.task?.phase, result.action === 'done' ? 'completed' : 'active')
  }
})
