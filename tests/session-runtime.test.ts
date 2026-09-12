import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRuntime, recoverSession } from '../web/src/sessionRuntime.js'
import { sessionTimeline } from '../web/src/sessionTimeline.js'

test('task interaction waits for a verified terminal snapshot and rejects late/wrong-run task events', () => {
  const runtime = new SessionRuntime()
  const task = { id:'t', revision:1, objective:'plan', phase:'active' as const, lastRunId:'r', previousContext:[], completedTaskIds:[], failedTaskIds:[] }
  const detail = { id:'s', running:false, messages:[], runs:[], state:{ sessionId:'s', allowedPaths:[], task } }
  runtime.snapshot('s', runtime.snapshotToken('s'), detail)
  runtime.begin('s', 'req', 'plan')
  assert.equal(runtime.interactionRuntime('s').submitting, true)
  const run = { id:'r', sessionId:'s', prompt:'plan', status:'running' as const, createdAt:1, messageIds:[] }
  runtime.event('s', 'req', { type:'run', run })
  assert.equal(runtime.interactionRuntime('s').submitting, false)
  runtime.event('s', 'req', { type:'task', runId:'other', task:{ ...task, phase:'completed', lastRunId:'other' } })
  assert.equal(runtime.detail('s')?.state.task?.phase, 'active')
  runtime.event('s', 'req', { type:'run', run:{ ...run, status:'cancelled' } })
  runtime.event('s', 'req', { type:'task', runId:'r', task:{ ...task, phase:'completed' } })
  runtime.event('s', 'req', { type:'run', run:{ ...run, status:'completed' } })
  assert.equal(runtime.detail('s')?.state.task?.phase, 'active')
  assert.equal(runtime.detail('s')?.runs?.[0].status, 'cancelled')
  assert.equal(runtime.interactionRuntime('s').syncing, true)
  runtime.end('s', 'req', true)
  runtime.snapshot('s', runtime.snapshotToken('s'), { ...detail, state:{ ...detail.state, task:{ ...task, phase:'paused' } }, runs:[{ ...run, status:'cancelled' }] })
  assert.equal(runtime.interactionRuntime('s').syncing, false)
})

test('retry clears only the matching request partial output and keeps other sessions intact', () => {
  const runtime = new SessionRuntime()
  runtime.begin('A', 'a', 'retry me')
  runtime.begin('B', 'b', 'leave me')
  runtime.event('A', 'a', { type: 'output', message: 'previous finalized segment' })
  runtime.event('A', 'a', { type: 'delta', text: 'failed partial' })
  runtime.event('B', 'b', { type: 'delta', text: 'other session' })
  runtime.event('A', 'a', { type: 'retry', attempt: 1, maxAttempts: 3, reason: '服务端错误', delayMs: 100 })
  assert.deepEqual(runtime.view('A').timeline.filter(row => row.role === 'assistant').map(row => row.content), ['previous finalized segment'])
  assert.equal(runtime.view('A').deltaCount, 0)
  assert.match(runtime.view('A').status, /正在重试 1\/3/)
  assert.equal(runtime.view('B').timeline.at(-1)?.content, 'other session')
  runtime.event('A', 'a', { type: 'delta', text: 'successful attempt' })
  runtime.event('A', 'a', { type: 'output', message: 'successful attempt' })
  assert.equal(runtime.view('A').timeline.filter(row => row.content === 'successful attempt').length, 1)
  runtime.end('A', 'a')
  const before = structuredClone(runtime.view('A'))
  runtime.event('A', 'a', { type: 'retry', attempt: 2, maxAttempts: 3, reason: 'late event', delayMs: 100 })
  assert.deepEqual(runtime.view('A'), before)
})

test('parallel sessions and stream buffers remain independent', () => {
  const runtime = new SessionRuntime()
  runtime.begin('A', 'a', 'same')
  runtime.begin('B', 'b', 'same')
  runtime.event('A', 'a', { type: 'delta', text: 'A text' })
  runtime.event('B', 'b', { type: 'delta', text: 'B text' })
  runtime.end('B', 'b')
  assert.equal(runtime.isRunning('B'), false)
  assert.equal(runtime.isRunning('A'), true)
  assert.equal(runtime.view('B').timeline.some(m => m.content.includes('A text')), false)
  assert.equal(runtime.view('A').timeline.some(m => m.content.includes('B text')), false)
})

test('task phases determine idle status while completed runs only mean the turn ended', () => {
  const runtime = new SessionRuntime()
  const phases = { active: '本轮运行结束', awaiting_input: '等待补充信息', awaiting_confirmation: '等待确认', paused: '任务已暂停', completed: '任务完成', cancelled: '任务已取消' } as const
  for (const [phase, label] of Object.entries(phases)) {
    runtime.snapshot('A', runtime.snapshotToken('A'), { id: 'A', running: false, messages: [], state: { sessionId: 'A', allowedPaths: [], task: { id: 'task-A', revision: 1, objective: 'A', phase: phase as keyof typeof phases, previousContext: [], completedTaskIds: [], failedTaskIds: [] } } })
    assert.equal(runtime.view('A').status, label)
  }
  assert.equal(sessionTimeline([], [{ id: 'r', sessionId: 'A', prompt: 'A', status: 'completed', createdAt: 1, messageIds: [] }]).at(-1)?.content, '本轮运行结束')
})

test('stale snapshots cannot replace new stream output or newer snapshots', () => {
  const runtime = new SessionRuntime()
  const old = runtime.snapshotToken('A')
  runtime.begin('A', 'a', 'prompt')
  assert.equal(runtime.snapshot('A', old, { id:'A', messages:[], state:{allowedPaths:[],sessionId:'A'}, running:false }), false)
  assert.equal(runtime.isRunning('A'), true)
  const first = runtime.snapshotToken('B'), second = runtime.snapshotToken('B')
  const detail = { id:'B', messages:[], state:{allowedPaths:[],sessionId:'B'}, running:false }
  assert.equal(runtime.snapshot('B', second, detail), true)
  assert.equal(runtime.snapshot('B', first, detail), false)
})

test('stable prompt identity avoids early snapshot duplicates, but repeated text is retained', () => {
  const runs = ['u1', 'u2'].map((id, n) => ({ id:`r${n}`, sessionId:'A', prompt:'same', userMessageId:id, messageIds:[], status:'running' as const, createdAt:n }))
  const messages = [{uuid:'u1',role:'user' as const,content:'same',createdAt:0}]
  const items = sessionTimeline(messages, runs)
  assert.equal(items.filter(x=>x.role==='user').length, 2)
  assert.equal(items.filter(x=>x.id==='u1').length, 1)
})

test('recovery serially retries failures, applies final snapshot and stops polling', async () => {
  let calls = 0, applied = 0
  const delays: number[] = []
  await recoverSession({
    signal: new AbortController().signal,
    load: async () => { calls++; if(calls===1) throw new Error('offline'); return {running:calls<3} },
    apply: () => { applied++ },
    onError: () => {},
    wait: async ms => { delays.push(ms) },
  })
  assert.equal(calls,3)
  assert.equal(applied,2)
  assert.equal(delays.length,2)
  assert.ok(delays.every(n=>n<=10000))
})

test('queued requests in one session and abort state do not affect another session', () => {
  const runtime = new SessionRuntime()
  runtime.begin('A', 'a1', 'one')
  runtime.begin('A', 'a2', 'two')
  runtime.aborting('A', true)
  runtime.begin('B', 'b', 'three')
  assert.equal(runtime.view('B').aborting, false)
  runtime.event('A', 'a1', {type:'aborted',message:'cancelled'})
  runtime.end('A', 'a1')
  assert.equal(runtime.isRunning('A'), true)
  runtime.event('A', 'a2', {type:'start'})
  assert.equal(runtime.view('A').aborting, false, 'FIFO successor has its own stop button')
  runtime.end('A', 'a2', true)
  assert.equal(runtime.isRunning('A'), true, 'EOF waits for authoritative recovery')
  runtime.snapshot('A', runtime.snapshotToken('A'), {id:'A',running:false,messages:[],state:{allowedPaths:[],sessionId:'A'}})
  assert.equal(runtime.isRunning('A'), false)
  assert.equal(runtime.isRunning('B'), true)
})

test('cancelling recovery suppresses late results and starts no next request', async () => {
  const controller = new AbortController()
  let resolve!: (value: {running:boolean}) => void
  const pending = new Promise<{running:boolean}>(done => { resolve = done })
  let applied = 0
  const recovery = recoverSession({signal:controller.signal,load:()=>pending,apply:()=>{applied++},onError:()=>{},wait:async()=>{assert.fail('cancelled recovery must not wait')}})
  controller.abort()
  resolve({running:true})
  await recovery
  assert.equal(applied,0)
})
