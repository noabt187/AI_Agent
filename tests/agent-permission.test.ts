import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { capabilitiesForState } from '../src/orchestrator/agent.js'
import { normalizeMemorySettings, type WorldState } from '../src/orchestrator/types.js'
import {
  executeTool,
  toolDefsForCapabilities,
} from '../src/tools/index.js'

function state(): WorldState {
  return {
    sessionId: 'permission-test',
    allowedPaths: ['C:\\workspace'],
    memorySettings: normalizeMemorySettings(),
    completedTaskIds: [],
    failedTaskIds: [],
    designConfirmed: false,
  }
}

function names(current: WorldState, skills = new Set<string>()): string[] {
  return toolDefsForCapabilities(capabilitiesForState(current, skills))
    .map((item) => item.function.name)
}

test('read-only state does not expose mutation or verification tools', () => {
  const visible = names(state())
  assert.ok(visible.includes('readTextFile'))
  assert.ok(!visible.includes('writeFile'))
  assert.ok(!visible.includes('verifyCode'))
  assert.ok(!visible.includes('createPullRequest'))
  assert.ok(!visible.includes('saveCheckpoint'))
})

test('workspace authorization exposes local write and verification only', () => {
  const current = state()
  current.authorization = { scope: 'workspace_write', taskId: 'task-1', authorizationId: 1 }
  const visible = names(current)
  assert.ok(visible.includes('writeFile'))
  assert.ok(visible.includes('deleteFile'))
  assert.ok(visible.includes('cloneRepository'))
  assert.ok(visible.includes('verifyCode'))
  assert.ok(!visible.includes('createPullRequest'))
  assert.ok(!visible.includes('forkRepository'))
})

test('remote git authorization does not inherit workspace write access', () => {
  const current = state()
  current.authorization = { scope: 'remote_git', taskId: 'task-2', authorizationId: 2 }
  const visible = names(current)
  assert.ok(visible.includes('createPullRequest'))
  assert.ok(visible.includes('forkRepository'))
  assert.ok(!visible.includes('writeFile'))
  assert.ok(!visible.includes('cloneRepository'))
})

test('memory tool appears only after auto-memory is loaded', () => {
  assert.ok(!names(state()).includes('writeMemory'))
  assert.ok(names(state(), new Set(['auto-memory'])).includes('writeMemory'))
})

test('execution layer rejects stale write calls even when legacy flag is true', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-permission-'))
  const result = await executeTool(
    'writeFile',
    { filePath: resolve(rootDir, 'blocked.txt'), content: 'blocked' },
    [rootDir],
    true,
    undefined,
    { authorizedCapabilities: new Set(['read']) },
  )
  assert.match(result, /workspace_write 权限/)
})
