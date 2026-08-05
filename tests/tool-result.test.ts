import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { executeToolResult } from '../src/tools/index.js'

test('executeToolResult returns stable codes for unknown and invalid calls', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-tool-result-'))
  const unknown = await executeToolResult('missing', {}, [rootDir])
  assert.deepEqual(unknown, {
    ok: false,
    code: 'UNKNOWN_TOOL',
    message: '未知工具 "missing"',
    retryable: false,
  })

  const invalid = await executeToolResult('readTextFile', { filePath: 'relative.txt' }, [rootDir])
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'PATH_OUTSIDE_ALLOWED')
})

test('executeToolResult distinguishes permission and checkpoint failures', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-tool-result-'))
  const filePath = resolve(rootDir, 'file.txt')
  const denied = await executeToolResult(
    'writeFile',
    { filePath, content: 'x' },
    [rootDir],
    false,
    undefined,
    { authorizedCapabilities: new Set(['read']) },
  )
  assert.equal(denied.code, 'PERMISSION_DENIED')

  const missingCheckpoint = await executeToolResult(
    'writeFile',
    { filePath, content: 'x' },
    [rootDir],
    true,
    undefined,
    { authorizedCapabilities: new Set(['read', 'workspace_write']) },
  )
  assert.equal(missingCheckpoint.code, 'CHECKPOINT_FAILED')
})
