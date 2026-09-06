import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Orchestrator } from '../src/orchestrator/orchestrator.js'
import { canWriteTask } from '../src/orchestrator/taskState.js'
import { legacyAgentRuntime } from '../src/orchestrator/runtime.js'
import { SessionPromptQueue } from '../src/server/promptQueue.js'
import * as api from '../src/server/sessionApi.js'
import { handleCoreRequest } from '../src/server/coreRoutes.js'
import { RunStore } from '../src/state/runStore.js'

function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r }); return { promise, release } }

test('HTTP admission binds controls durably and FIFO rejects stale confirmations without granting writes', async t => {
  const id = `task-http-${randomUUID()}`, dir = resolve('state', id)
  await mkdir(dir, { recursive: true })
  const writes: string[] = []
  const o = new Orchestrator(id, undefined, undefined, { run: async (_id, input, state, _signal, _event, _metric, _message, turn) => {
    if (input === '确认') { if (canWriteTask(state, turn!)) writes.push(input); return { action: 'chat', message: 'accepted' } }
    return { action: 'confirm', prompt: `full ${input}`, message: 'short', confirmType: input === 'requirements' ? undefined : 'allow_write', selections: ['one', 'two'] }
  } })
  o.state.allowedPaths = [process.cwd()]
  t.mock.method(Orchestrator, 'load', async () => o)
  let hold: ReturnType<typeof gate> | undefined
  let entered = gate()
  const queue = new SessionPromptQueue(async job => {
    entered.release()
    await hold?.promise
    await o.handleUserInput(job.prompt, job.onEvent, job.signal, job.userMessageId, job.binding)
  }, () => o.abort())
  const restore = api.configureSessionRuntime(legacyAgentRuntime, queue)
  const server = createServer((req, res) => { void handleCoreRequest(req, res) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const address = server.address() as { port: number }
  const request = (suffix: string, body: unknown, method = 'POST') => fetch(`http://127.0.0.1:${address.port}/api/sessions/${id}/${suffix}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  t.after(async () => { hold?.release(); await api.deleteSession(id); restore(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true, maxRetries: 5 }) })
  await (await request('stream', { prompt: 'A' })).text()
  const p = o.state.task!.pendingConfirmation!
  const control = { kind: 'confirm', taskId: p.taskId, taskRevision: p.taskRevision, confirmationId: p.id }
  const invalid = await request('stream', { prompt: '确认', control: { ...control, selection: 'missing' } })
  assert.equal(invalid.status, 400)
  assert.equal((await request('stream', { prompt: '确认，但只读', control })).status, 400)
  hold = gate(); entered = gate()
  const delayed = request('stream', { prompt: '确认' })
  await entered.promise
  const records = JSON.parse(await readFile(resolve(dir, 'runs.json'), 'utf8'))
  assert.deepEqual(records.at(-1).binding.control, control)
  await o.handleUserInput('B', undefined, undefined, undefined, o.bindInput('B', { ...control, kind: 'revise' }))
  const current = o.state.task!.pendingConfirmation!.id
  hold.release(); hold = undefined
  assert.match(await (await delayed).text(), /方案|版本/)
  assert.equal(o.state.task!.pendingConfirmation!.id, current)
  assert.equal(writes.length, 0)
  assert.equal(o.state.task!.approval, undefined)
  assert.equal((await request('stream', { prompt: '确认', control })).status, 409)
  assert.equal((await request('pending-confirm', { expected: control }, 'DELETE')).status, 409)
  assert.equal(o.state.task!.pendingConfirmation!.id, current)
  const latest = o.state.task!.pendingConfirmation!
  const next = { kind: 'confirm', taskId: latest.taskId, taskRevision: latest.taskRevision, confirmationId: latest.id }
  await (await request('stream', { prompt: '确认', control: next })).text()
  assert.equal(writes.length, 1)
  assert.equal((await request('stream', { prompt: '确认', control: next })).status, 409)
  const detail = await api.loadSession(id) as { runs: { id: string; taskId?: string; taskRevision?: number; taskPhase?: string; status: string }[] }
  const run = detail.runs.find(r => r.id === o.state.task!.lastRunId)!
  assert.equal(run.taskId, o.state.task!.id)
  assert.equal(run.taskRevision, o.state.task!.revision)
  assert.equal(run.taskPhase, 'active')
  assert.equal(run.status, 'completed')
  await (await request('stream', { prompt: 'requirements' })).text()
  await (await request('stream', { prompt: '确认' })).text()
  assert.equal(writes.length, 1, 'requirements confirmation must remain read-only')
  assert.equal(o.state.task!.approval, undefined)
  hold = gate(); entered = gate()
  const moved = request('stream', { prompt: 'queued for old directory' })
  await entered.promise
  await api.updateAllowedPaths(id, [dir])
  hold.release(); hold = undefined
  assert.match(await (await moved).text(), /目录或仓库已改变/)
  const final = await api.loadSession(id) as { runs: { status: string; error?: string }[] }
  assert.equal(final.runs.at(-1)?.status, 'failed')
  assert.match(final.runs.at(-1)?.error ?? '', /目录或仓库已改变/)
  assert.equal(writes.length, 1)
})

test('idle recovery reconciles real run associations and concurrent loaders share one orchestrator', async t => {
  for (const status of ['running', 'cancelled', 'completed'] as const) {
    const id = `task-recover-${randomUUID()}`, dir = resolve('state', id)
    const store = new RunStore(resolve('state'))
    const row = await store.create(id, 'confirmed execution')
    const controller = new AbortController()
    const o = new Orchestrator(id, undefined, undefined, { run: async (_id, input) => {
      if (input === 'A') return { action: 'confirm', prompt: 'approved proposal', confirmType: 'allow_write' }
      if (status === 'cancelled') controller.abort()
      return { action: 'chat', message: 'saved progress' }
    } })
    o.state.allowedPaths = [process.cwd()]
    await o.handleUserInput('A')
    await o.handleUserInput('确认', undefined, controller.signal, row.userMessageId, o.bindInput('确认', undefined, { runId: row.id, userMessageId: row.userMessageId! })).catch(error => { if (error.name !== 'AbortError') throw error })
    await store.update(id, row.id, { status, taskId: o.state.task!.id, taskRevision: o.state.task!.revision, taskPhase: o.state.task!.phase })
    t.after(async () => { await api.deleteSession(id); await rm(dir, { recursive: true, force: true }) })
    const [first, second] = await Promise.all([api.getOrchestrator(id), api.getOrchestrator(id)])
    assert.equal(first, second)
    const detail = await api.loadSession(id) as { runs: { status: string }[] }
    assert.equal(detail.runs[0].status, status === 'running' ? 'interrupted' : status)
    assert.equal(first.state.task!.phase, status === 'completed' ? 'active' : 'paused')
    assert.equal(!!first.state.task!.approval, status !== 'running')
  }
})

test('real queue stop finalizes owned task A before B starts and reads never reconcile active execution', async t => {
  const id = `task-stop-${randomUUID()}`, dir = resolve('state', id)
  const started = gate(), admittedB = gate(), finish = gate()
  const o = new Orchestrator(id, undefined, undefined, { run: async (_id, input, state, signal) => {
    if (input === 'A') {
      started.release()
      await new Promise<void>(r => signal!.addEventListener('abort', () => r(), { once: true }))
      await finish.promise
    } else assert.equal(state.task!.objective, 'B')
    return { action: 'chat', message: input }
  } })
  o.state.allowedPaths = [process.cwd()]
  t.mock.method(Orchestrator, 'load', async () => o)
  const restore = api.configureSessionRuntime(legacyAgentRuntime, api.createSessionPromptQueue())
  t.after(async () => { finish.release(); await api.deleteSession(id); restore(); await rm(dir, { recursive: true, force: true }) })
  const first = api.enqueueSessionPrompt({ sessionId: id, prompt: 'A', onEvent: () => {} }).catch(error => error)
  await started.promise
  const taskA = o.state.task!.id
  await api.loadSession(id)
  assert.equal(o.state.task!.phase, 'active')
  await assert.rejects(api.updateAllowedPaths(id, [dir]), /运行期间/)
  const second = api.enqueueSessionPrompt({ sessionId: id, prompt: 'B', onAccepted: () => admittedB.release(), onEvent: () => {} })
  await admittedB.promise
  let stopped = false
  const stop = api.abortSession(id).then(() => { stopped = true })
  assert.equal(stopped, false)
  finish.release()
  await Promise.all([first, second, stop])
  const detail = await api.loadSession(id) as { runs: { status: string; taskId?: string; taskPhase?: string }[] }
  assert.deepEqual(detail.runs.map(r => r.status), ['cancelled', 'completed'])
  assert.equal(detail.runs[0].taskId, taskA)
  assert.equal(detail.runs[0].taskPhase, 'paused')
  assert.notEqual(o.state.task!.id, taskA)
  assert.equal(o.state.task!.objective, 'B')
  assert.equal(o.state.task!.phase, 'active')
})
