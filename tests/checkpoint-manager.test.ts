import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  captureFileCheckpoint,
  readCheckpoint,
  restoreCheckpoint,
  type CheckpointContext,
} from '../src/checkpoint/checkpointManager.js'
import { executeTool, executeToolResult } from '../src/tools/index.js'

async function fixture(): Promise<{ rootDir: string; context: CheckpointContext }> {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-checkpoint-workspace-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'agent-checkpoint-state-'))
  return {
    rootDir,
    context: {
      sessionId: 'session-1',
      taskId: 'task-1',
      authorizationId: 1,
      stateRoot,
    },
  }
}

test('checkpoint captures each file only once and restores the original content', async () => {
  const { rootDir, context } = await fixture()
  const filePath = resolve(rootDir, 'source.txt')
  await writeFile(filePath, 'original', 'utf8')

  await captureFileCheckpoint(context, filePath)
  await writeFile(filePath, 'first edit', 'utf8')
  await captureFileCheckpoint(context, filePath)
  await writeFile(filePath, 'second edit', 'utf8')

  const manifest = await readCheckpoint(context)
  assert.equal(manifest.files.length, 1)
  await restoreCheckpoint(context)
  assert.equal(await readFile(filePath, 'utf8'), 'original')
})

test('checkpoint removes files created by the current task during restore', async () => {
  const { rootDir, context } = await fixture()
  const filePath = resolve(rootDir, 'new.txt')
  await captureFileCheckpoint(context, filePath)
  await writeFile(filePath, 'created', 'utf8')
  await restoreCheckpoint(context)
  await assert.rejects(readFile(filePath, 'utf8'), /ENOENT/)
})

test('executeTool captures a preimage before an authorized write', async () => {
  const { rootDir, context } = await fixture()
  const filePath = resolve(rootDir, 'managed.txt')
  await writeFile(filePath, 'before', 'utf8')
  const result = await executeTool(
    'writeFile',
    { filePath, content: 'after' },
    [rootDir],
    true,
    undefined,
    {
      authorizedCapabilities: new Set(['read', 'workspace_write']),
      checkpoint: context,
    },
  )
  assert.match(result, /已写入/)
  assert.equal((await readCheckpoint(context)).files.length, 1)
  await restoreCheckpoint(context)
  assert.equal(await readFile(filePath, 'utf8'), 'before')
})

test('new execution path refuses writes without checkpoint context', async () => {
  const { rootDir } = await fixture()
  const result = await executeToolResult(
    'writeFile',
    { filePath: resolve(rootDir, 'blocked.txt'), content: 'after' },
    [rootDir],
    true,
    undefined,
    { authorizedCapabilities: new Set(['read', 'workspace_write']) },
  )
  assert.equal(result.code, 'CHECKPOINT_FAILED')
})
