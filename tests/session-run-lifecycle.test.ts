import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

test('followup is checked against durable source ownership both at admission and dequeue', async t => {
  const api = await import('../src/server/sessionApi.js')
  const { SessionPromptQueue } = await import('../src/server/promptQueue.js')
  const { sessionRunStore: store } = await import('../src/state/runStore.js')
  const { legacyAgentRuntime } = await import('../src/orchestrator/runtime.js')
  const { beginTaskTurn } = await import('../src/orchestrator/taskState.js')
  const id = `host-followup-${randomUUID()}`
  let executions = 0
  const queue = new SessionPromptQueue(async job => {
    executions++
    const o = api.peekOrchestrator(id)!
    beginTaskTurn(o.state, job.binding!)
    await job.onEvent({ type: 'task', runId: job.binding!.runId, task: structuredClone(o.state.task!) })
  })
  const restore = api.configureSessionRuntime(legacyAgentRuntime, queue)
  t.after(async () => { await api.deleteSession(id); restore() })
  await api.loadSession(id)
  const o = api.peekOrchestrator(id)!
  const binding = o.bindInput('source')
  const turn = beginTaskTurn(o.state, binding)
  await store.create(id, 'source', binding)
  await store.update(id, turn.runId, { binding, taskId: turn.taskId, taskRevision: turn.taskRevision, status: 'running' })
  const control = { kind: 'followup', taskId: turn.taskId, taskRevision: turn.taskRevision, sourceRunId: turn.runId } as const
  const submit = (extra = {}) => api.enqueueSessionPrompt({ sessionId: id, prompt: 'new explanation', control, onEvent() {}, ...extra })
  await assert.rejects(submit(), /来源运行/)
  await store.update(id, turn.runId, { status: 'completed' })
  let release!: () => void, admitted!: () => void
  const gate = new Promise<void>(r => { release = r })
  const ready = new Promise<void>(r => { admitted = r })
  const delayed = submit({ onAccepted: async () => { admitted(); await gate } })
  const rejected = assert.rejects(delayed, /任务版本/)
  await ready
  try { await submit() } finally { release() }
  await rejected
  assert.equal(executions, 1, 'the stale queued followup never reaches the executor')
  assert.equal(o.state.task!.revision, 2)
  assert.equal(o.state.task!.approval, undefined)
  const runs = await store.list(id)
  assert.deepEqual(runs.map(run => run.status), ['completed', 'failed', 'completed'])
})

test('session submission persists cancellation and partial output before the FIFO successor starts', async t => {
  const sessionId = `session-lifecycle-${randomUUID()}`
  const dir = resolve('state', sessionId)
  await mkdir(dir, { recursive: true })
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
      await job.onEvent({ type: 'result', result: { action: 'chat', message: 'partial', protocolFallback: true } })
      await job.onEvent({ type: 'delta', text: '{"action":"chat","message":"已生成一半' })
      await job.onEvent({ type: 'tool_call', name: 'verifyCode', arguments: '{}' })
      started()
      await new Promise<void>(resolve => job.signal!.addEventListener('abort', () => resolve(), { once: true }))
      await job.onEvent({ type: 'aborted', message: 'cancelled' })
    }
  })
  const restore = api.configureSessionRuntime(legacyAgentRuntime, queue)
  t.after(async () => { await api.deleteSession(sessionId); restore(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const events: string[] = []
  const onEvent: import('../src/orchestrator/types.js').AgentEventHandler = event => {
    if (event.type === 'run') events.push(`${event.run.prompt}:${event.run.status}`)
  }
  const first = api.enqueueSessionPrompt({ sessionId, prompt: 'first', origin: 'plugin', onEvent })
  await start
  const { readFile } = await import('node:fs/promises')
  const liveRuns = JSON.parse(await readFile(resolve(dir, 'runs.json'), 'utf8'))
  assert.deepEqual(liveRuns[0].messageIds, [liveRuns[0].userMessageId], 'running snapshots already link the saved prompt')
  const second = api.enqueueSessionPrompt({ sessionId, prompt: 'second', onEvent })
  await api.abortSession(sessionId)
  await Promise.all([first, second])
  const runs = await new RunStore(resolve('state')).list(sessionId)
  assert.deepEqual(runs.map(run => run.status), ['cancelled', 'completed'])
  assert.equal(runs[0].origin, 'plugin')
  assert.deepEqual(runs[0].resultMeta, { action: 'chat', protocolFallback: true })
  assert.deepEqual(runs.map(run => run.messageIds), runs.map(run => [run.userMessageId]))
  assert.notEqual(runs[0].userMessageId, runs[1].userMessageId)
  assert.match(runs[0].partialOutput!, /已生成一半/)
  assert.ok(events.indexOf('first:cancelled') < events.indexOf('second:running'))
})
