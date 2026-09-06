import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Orchestrator } from '../src/orchestrator/orchestrator.js'
import { Agent } from '../src/orchestrator/agent.js'
import { applyTaskResult, beginTaskTurn, canWriteTask, pauseTask } from '../src/orchestrator/taskState.js'
import { legacyAgentRuntime } from '../src/orchestrator/runtime.js'
import { RunStore } from '../src/state/runStore.js'
import { loadMessages } from '../src/state/sessionStore.js'
import { SessionPromptQueue } from '../src/server/promptQueue.js'
import * as api from '../src/server/sessionApi.js'

function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r }); return { promise, release } }
function proposal(o: Orchestrator) {
  const turn = beginTaskTurn(o.state, o.bindInput('A: edit files'))
  applyTaskResult(o.state, turn, { action: 'confirm', prompt: 'proposal A', confirmType: 'allow_write' })
}

test('plain confirmation captures proposal A before RunStore admission I/O can replace it with B', async t => {
  const id = `final-admission-${randomUUID()}`, dir = resolve('state', id)
  await mkdir(dir, { recursive: true })
  const o = new Orchestrator(id); o.state.allowedPaths = [process.cwd()]
  t.mock.method(Orchestrator, 'load', async () => o)
  await api.getOrchestrator(id)
  proposal(o)
  const expected = o.state.task!.pendingConfirmation!.id
  const entered = gate(), held = gate()
  const create = RunStore.prototype.create
  t.mock.method(RunStore.prototype, 'create', async function (this: RunStore, ...args: Parameters<RunStore['create']>) {
    entered.release(); await held.promise; return create.apply(this, args)
  })
  let captured: string | undefined
  const restore = api.configureSessionRuntime(legacyAgentRuntime, new SessionPromptQueue(async job => {
    captured = job.binding!.control?.kind === 'confirm' ? job.binding!.control.confirmationId : undefined
    beginTaskTurn(o.state, job.binding!)
  }))
  t.after(async () => { held.release(); restore(); await api.deleteSession(id); await rm(dir, { recursive: true, force: true }) })
  const admitted = api.enqueueSessionPrompt({ sessionId: id, prompt: '确认', onEvent: () => {} }).catch(error => error)
  await entered.promise
  proposal(o)
  const newer = o.state.task!.pendingConfirmation!.id
  held.release()
  const error = await admitted
  assert.equal(captured, expected)
  assert.match(error?.message ?? '', /方案|版本/)
  assert.equal(o.state.task!.pendingConfirmation!.id, newer)
  assert.equal(o.state.task!.approval, undefined)
})

test('resume controls reject new constraints at admission and execution without mutating approval', () => {
  const o = new Orchestrator('final-resume'); proposal(o)
  const turn = beginTaskTurn(o.state, o.bindInput('确认'))
  pauseTask(o.state, turn, 'cancelled')
  const resume = o.bindInput('continue')
  const before = structuredClone(o.state)
  for (const input of ['Continue, but only read; do not edit', '继续，但只读，不要修改']) {
    assert.throws(() => o.bindInput(input, resume.control), /继续|约束/)
    assert.throws(() => beginTaskTurn(o.state, { ...resume, input }), /继续|约束/)
    assert.deepEqual(o.state, before)
  }
  const latest = beginTaskTurn(o.state, o.bindInput('Continue, but only read; do not edit'))
  assert.equal(o.state.task!.objective, latest.input)
  assert.equal(canWriteTask(o.state, latest), false)
})

for (const crash of [false, true]) {
  test(`CLI load ${crash ? 'revokes interrupted crash grant' : 'preserves explicitly finalized pause grant'}`, async t => {
    const id = `final-cli-${randomUUID()}`, dir = resolve('state', id)
    const controller = new AbortController()
    let crashState = '', crashRuns = ''
    const o = new Orchestrator(id, undefined, undefined, { run: async (_id, input) => {
      if (input === 'A') return { action: 'confirm', prompt: 'approved A', confirmType: 'allow_write' }
      crashState = await readFile(resolve(dir, 'orchestrator-state.json'), 'utf8')
      crashRuns = await readFile(resolve(dir, 'runs.json'), 'utf8').catch(() => '[]')
      controller.abort()
      return { action: 'chat', message: 'progress' }
    } })
    o.state.allowedPaths = [process.cwd()]
    t.after(() => rm(dir, { recursive: true, force: true }))
    await o.handleUserInput('A')
    await assert.rejects(o.handleUserInput('确认', undefined, controller.signal), { name: 'AbortError' })
    if (crash) {
      // Recreate the actual durable bytes observed while execution was active.
      await writeFile(resolve(dir, 'orchestrator-state.json'), crashState)
      await writeFile(resolve(dir, 'runs.json'), crashRuns)
      // A fresh process reconciles nonterminal rows before Orchestrator.load.
      await new RunStore(resolve('state')).list(id)
    }
    const loaded = await Orchestrator.load(id)
    assert.equal(loaded.state.task!.phase, 'paused')
    const resumed = beginTaskTurn(loaded.state, loaded.bindInput('continue'))
    assert.equal(canWriteTask(loaded.state, resumed), !crash)
    const records = await new RunStore(resolve('state')).list(id)
    assert.equal(records.at(-1)?.status, crash ? 'interrupted' : 'cancelled')
  })
}

for (const toolContinuation of [false, true]) {
  test(`real Agent/QueryEngine terminal failure finalizes failed run and paused task (${toolContinuation ? 'tool continuation' : 'initial response'})`, async t => {
    const id = `final-model-${randomUUID()}`, dir = resolve('state', id)
    await mkdir(dir, { recursive: true })
    let calls = 0
    const agent = new Agent(undefined, { async *streamChat() {
      calls++
      if (toolContinuation && calls === 1) yield { type: 'tool_calls', toolCalls: [{ id: 'read', name: 'readFile', arguments: JSON.stringify({ filePath: resolve('package.json') }) }] }
      else yield { type: 'error', error: 'HTTP 401 invalid credentials' }
      yield { type: 'done' }
    } })
    const o = new Orchestrator(id, { sessionId: id, allowedPaths: [process.cwd()], completedTaskIds: [], failedTaskIds: [], memorySettings: { recallMode: 'off' } }, undefined, agent)
    t.mock.method(Orchestrator, 'load', async () => o)
    await api.getOrchestrator(id)
    proposal(o)
    const restore = api.configureSessionRuntime(legacyAgentRuntime, api.createSessionPromptQueue())
    t.after(async () => { restore(); await api.deleteSession(id); await rm(dir, { recursive: true, force: true }) })
    await assert.rejects(api.enqueueSessionPrompt({ sessionId: id, prompt: '确认', onEvent: () => {} }), /HTTP 401/)
    const records = await new RunStore(resolve('state')).list(id)
    assert.equal(records.at(-1)?.status, 'failed')
    assert.equal(records.at(-1)?.taskPhase, 'paused')
    assert.equal(o.state.task!.phase, 'paused')
    assert.ok((await loadMessages(id)).some(message => message.isMeta && message.content === 'HTTP 401 invalid credentials'))
    assert.equal(calls, toolContinuation ? 2 : 1)
  })
}

test('successful empty QueryEngine response remains a completed chat turn', async t => {
  const id = `final-empty-${randomUUID()}`, dir = resolve('state', id)
  const o = new Orchestrator(id, { sessionId: id, allowedPaths: [process.cwd()], completedTaskIds: [], failedTaskIds: [], memorySettings: { recallMode: 'off' } }, undefined,
    new Agent(undefined, { async *streamChat() { yield { type: 'done' } } }))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await o.handleUserInput('empty success')
  assert.equal(o.state.task!.phase, 'active')
})

test('real QueryEngine recoverable intermediate failure may retry and complete normally', async t => {
  const id = `final-retry-${randomUUID()}`, dir = resolve('state', id)
  let calls = 0
  const o = new Orchestrator(id, { sessionId: id, allowedPaths: [process.cwd()], completedTaskIds: [], failedTaskIds: [], memorySettings: { recallMode: 'off' } }, undefined,
    new Agent(undefined, { async *streamChat() {
      if (++calls === 1) yield { type: 'error', error: 'HTTP 500 temporary outage' }
      else { yield { type: 'delta', text: JSON.stringify({ action: 'chat', message: 'recovered' }) }; yield { type: 'done' } }
    } }))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await o.handleUserInput('retry safely')
  assert.equal(calls, 2)
  assert.equal(o.state.task!.phase, 'active')
  assert.equal((await new RunStore(resolve('state')).list(id)).at(-1)?.status, 'completed')
})

test('late Stop after task return pauses owned A before run cancellation and cannot affect B', async t => {
  const id = `final-stop-${randomUUID()}`, dir = resolve('state', id)
  const o = new Orchestrator(id, undefined, undefined, { run: async (_id, input) => ({ action: 'chat', message: input }) })
  o.state.allowedPaths = [process.cwd()]
  t.mock.method(Orchestrator, 'load', async () => o)
  const afterA = gate(), releaseA = gate()
  let stop: Promise<void> | undefined
  const queue = new SessionPromptQueue(async job => {
    await o.handleUserInput(job.prompt, job.onEvent, job.signal, job.userMessageId, job.binding)
    if (job.prompt === 'A') { afterA.release(); await releaseA.promise; stop = queue.abort(id) }
    else {
      const records = JSON.parse(await readFile(resolve(dir, 'runs.json'), 'utf8'))
      assert.equal(records[0].status, 'cancelled')
      assert.equal(records[0].taskPhase, 'paused')
    }
  }, () => o.abort())
  const restore = api.configureSessionRuntime(legacyAgentRuntime, queue)
  t.after(async () => { releaseA.release(); restore(); await api.deleteSession(id); await rm(dir, { recursive: true, force: true }) })
  const first = api.enqueueSessionPrompt({ sessionId: id, prompt: 'A', onEvent: () => {} })
  await afterA.promise
  const second = api.enqueueSessionPrompt({ sessionId: id, prompt: 'B', onAccepted: () => releaseA.release(), onEvent: () => {} })
  await Promise.all([first, second]); await stop
  assert.equal(o.state.task!.objective, 'B')
  assert.equal(o.state.task!.phase, 'active')
})

test('Stop during committed run finalization leaves completion intact and waits for it', async () => {
  const entered = gate(), release = gate()
  let terminalSignal: AbortSignal | undefined, abortCalls = 0
  const queue = new SessionPromptQueue(async () => {}, () => { abortCalls++ })
  const run = queue.enqueue({ sessionId: 'boundary', prompt: 'A', onEvent: () => {}, onFinish: async (_error, signal) => {
    terminalSignal = signal; entered.release(); await release.promise
    assert.equal(signal?.aborted, false)
  } })
  await entered.promise
  const stop = queue.abort('boundary')
  assert.equal(terminalSignal?.aborted, false)
  assert.equal(abortCalls, 0)
  release.release(); await Promise.all([run, stop])
})
