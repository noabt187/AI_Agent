import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('session submission persists cancellation and partial output before the FIFO successor starts', async t => {
  const previousCwd = process.cwd()
  const dir = await mkdtemp(join(tmpdir(), 'agent-lifecycle-'))
  process.chdir(dir)
  t.after(async () => { process.chdir(previousCwd); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const api = await import('../src/server/sessionApi.js')
  const { SessionPromptQueue } = await import('../src/server/promptQueue.js')
  const { RunStore } = await import('../src/state/runStore.js')
  const { saveMessages, loadMessages } = await import('../src/state/sessionStore.js')
  const { legacyAgentRuntime } = await import('../src/orchestrator/runtime.js')
  let started!: () => void
  const start = new Promise<void>(resolve => { started = resolve })
  const queue = new SessionPromptQueue(async job => {
    const messages = await loadMessages(job.sessionId)
    assert.ok(job.userMessageId, 'user identity is reserved before execution')
    messages.push({ uuid: job.userMessageId, role: 'user', content: job.prompt, createdAt: Date.now() })
    await saveMessages(job.sessionId, messages)
    if (job.prompt === 'first') {
      await job.onEvent({ type: 'delta', text: '{"action":"chat","message":"已生成一半' })
      await job.onEvent({ type: 'tool_call', name: 'verifyCode', arguments: '{}' })
      started()
      await new Promise<void>(resolve => job.signal!.addEventListener('abort', () => resolve(), { once: true }))
      await job.onEvent({ type: 'aborted', message: 'cancelled' })
    }
  })
  const restore = api.configureSessionRuntime(legacyAgentRuntime, queue)
  t.after(restore)
  const events: string[] = []
  const onEvent: import('../src/orchestrator/types.js').AgentEventHandler = event => {
    if (event.type === 'run') events.push(`${event.run.prompt}:${event.run.status}`)
  }
  const first = api.enqueueSessionPrompt({ sessionId: 'session-qa', prompt: 'first', onEvent })
  await start
  const { readFile } = await import('node:fs/promises')
  const liveRuns = JSON.parse(await readFile(join(dir, 'state/session-qa/runs.json'), 'utf8'))
  assert.deepEqual(liveRuns[0].messageIds, [liveRuns[0].userMessageId], 'running snapshots already link the saved prompt')
  const second = api.enqueueSessionPrompt({ sessionId: 'session-qa', prompt: 'second', onEvent })
  await api.abortSession('session-qa')
  await Promise.all([first, second])
  const runs = await new RunStore(join(dir, 'state')).list('session-qa')
  assert.deepEqual(runs.map(run => run.status), ['cancelled', 'completed'])
  assert.deepEqual(runs.map(run => run.messageIds), runs.map(run => [run.userMessageId]))
  assert.notEqual(runs[0].userMessageId, runs[1].userMessageId)
  assert.match(runs[0].partialOutput!, /已生成一半/)
  assert.ok(events.indexOf('first:cancelled') < events.indexOf('second:running'))
})
