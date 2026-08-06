import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Orchestrator } from '../src/orchestrator/orchestrator.js'
import type { AgentResult, WorldState } from '../src/orchestrator/types.js'
import { normalizeMemorySettings } from '../src/orchestrator/types.js'
import { executeToolResult, toolDefsToOpenAI } from '../src/tools/index.js'

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

test('chat and done both clear the current task permission', async () => {
  const orchestrator = new Orchestrator('permission-reset', state('permission-reset'))
  const handler = orchestrator as unknown as {
    handleAgentResult(result: AgentResult): Promise<void>
  }

  for (const result of [
    { action: 'chat', message: '回答完成' } as const,
    { action: 'done', message: '修改完成' } as const,
  ]) {
    orchestrator.state.designConfirmed = true
    orchestrator.state.goal = 'test goal'
    orchestrator.state.pendingConfirm = { allowWrite: true, message: 'test' }
    await handler.handleAgentResult(result)
    assert.equal(orchestrator.state.designConfirmed, false)
    assert.equal(orchestrator.state.goal, undefined)
    assert.equal(orchestrator.state.pendingConfirm, undefined)
  }
})
