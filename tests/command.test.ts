import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommand, CommandError } from '../src/utils/command.js'

test('npm runs from a directory containing spaces and arguments remain literal', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent command space '))
  t.after(() => rm(dir, { recursive: true, force: true }))
  assert.match((await runCommand('npm', ['--version'], dir)).stdout.trim(), /^\d+\.\d+\.\d+/)
  const value = 'space & echo injected | $HOME %PATH%'
  assert.equal((await runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', value], dir)).stdout, value)
})

test('command failures retain classification and output', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', "console.error('bad test');process.exit(7)"], process.cwd()),
    e => e instanceof CommandError && e.kind === 'exit' && e.exitCode === 7 && e.stderr.includes('bad test'))
  await assert.rejects(runCommand('ai-agent-no-such-executable', [], process.cwd()),
    e => e instanceof CommandError && e.kind === 'start')
  await assert.rejects(runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], process.cwd(), 100),
    e => e instanceof CommandError && e.kind === 'timeout')
})

test('abort cancels an active command', async () => {
  const controller = new AbortController()
  const promise = runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], process.cwd(), 10_000, controller.signal)
  setTimeout(() => controller.abort(), 100)
  await assert.rejects(promise, e => e instanceof CommandError && e.kind === 'aborted')
})
