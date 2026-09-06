import assert from 'node:assert/strict'
import test from 'node:test'
import { Orchestrator } from '../src/orchestrator/orchestrator.js'
import { maybeCompressContext } from '../src/context/contextCompressor.js'

test('abort during directory setup prevents setup mutation and the following special command', async () => {
  const controller = new AbortController()
  const orchestrator = new Orchestrator('session-cancel-fixture')
  orchestrator.setAskInput(async () => { controller.abort(); return process.cwd() })
  let wroteMemory = false
  orchestrator.rememberMemory = async () => { wroteMemory = true; throw new Error('must not execute') }
  await assert.rejects(orchestrator.handleUserInput('/remember should not save', () => {}, controller.signal), { name: 'AbortError' })
  assert.deepEqual(orchestrator.state.allowedPaths, [])
  assert.equal(wroteMemory, false)
})

test('context compression respects a pre-aborted request before reading or changing history', async () => {
  await assert.rejects(maybeCompressContext('session-cancel-fixture', 1, 1, AbortSignal.abort()), { name: 'AbortError' })
})
