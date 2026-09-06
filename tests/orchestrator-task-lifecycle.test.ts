import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Orchestrator } from '../src/orchestrator/orchestrator.js'
import { Agent } from '../src/orchestrator/agent.js'
import { canWriteTask } from '../src/orchestrator/taskState.js'
import { loadMessages, loadOrchestratorState, saveMessages } from '../src/state/sessionStore.js'
import type { AgentEventHandler, AgentResult, TurnContext, WorldState } from '../src/orchestrator/types.js'

test('abort A then ordinary B replaces current objective without A authority', async () => {
  const id = `task-test-${randomUUID()}`
  const controller = new AbortController()
  const observed: string[] = []
  const o = new Orchestrator(id, undefined, undefined, { run: async (_id, input, state, _signal, _event, _metric, _message, turn) => {
    observed.push(state.task!.objective)
    assert.equal(canWriteTask(state, turn!), false)
    if (input === 'A') controller.abort()
    return { action: 'chat', message: input }
  } }
  )
  o.state.allowedPaths = [process.cwd()]
  try {
    await o.handleUserInput('A', undefined, controller.signal).catch(() => {})
    assert.equal(o.state.task?.phase, 'paused')
    const previousTaskId = o.state.task!.id
    await o.handleUserInput('B: read package.json')
    assert.equal(o.state.task?.objective, 'B: read package.json')
    assert.equal(o.state.task?.approval, undefined)
    assert.notEqual(o.state.task?.id, previousTaskId)
    assert.deepEqual(observed, ['A', 'B: read package.json'])
  } finally { await rm(resolve('state', id), { recursive: true, force: true }) }
})

test('real model request uses B after approved A stops, real write tool denies A grant, UUID is not duplicated', async () => {
  const id = `task-test-${randomUUID()}`, dir = resolve('state', id)
  await mkdir(dir, { recursive: true })
  const file = resolve(dir, 'package.json')
  await writeFile(file, '{"untouched":true}')
  let call = 0
  const controller = new AbortController()
  const agent = new Agent(undefined, { async *streamChat(messages) {
    call++
    if (call === 1) yield { type: 'delta', text: JSON.stringify({ action: 'confirm', confirmType: 'allow_write', prompt: 'A writes package.json' }) }
    else if (call === 2) { controller.abort(); yield { type: 'delta', text: 'late A' } }
    else if (call === 3) {
      const request = messages.filter(m => m.role === 'user' && !m.isMeta).at(-1)!
      assert.match(request.content, /本轮执行依据（最新请求，优先于历史）: B: read package.json/)
      assert.doesNotMatch(request.content, /用户目标: A/)
      yield { type: 'tool_calls', toolCalls: [{ id: 'write-attempt', name: 'writeFile', arguments: JSON.stringify({ filePath: file, content: 'changed' }) }] }
    } else {
      assert.match(messages.find(m => m.toolCallId === 'write-attempt')!.content, /确认|权限/)
      yield { type: 'delta', text: JSON.stringify({ action: 'chat', message: 'B response' }) }
    }
    yield { type: 'done' }
  } })
  const o = new Orchestrator(id, { sessionId: id, allowedPaths: [dir], completedTaskIds: [], failedTaskIds: [], memorySettings: { recallMode: 'off' } }, undefined, agent)
  try {
    await o.handleUserInput('A')
    await assert.rejects(o.handleUserInput('确认', undefined, controller.signal), { name: 'AbortError' })
    const previous = o.state.task!.id
    assert.equal(o.state.task!.phase, 'paused')
    assert.ok(o.state.task!.approval)
    const userMessageId = randomUUID()
    const messages = await loadMessages(id)
    messages.push({ uuid: userMessageId, role: 'user', content: 'B: read package.json', createdAt: Date.now() })
    await saveMessages(id, messages)
    await o.handleUserInput('B: read package.json', undefined, undefined, userMessageId)
    assert.notEqual(o.state.task!.id, previous)
    assert.equal(o.state.task!.approval, undefined)
    assert.equal(await readFile(file, 'utf8'), '{"untouched":true}')
    assert.equal((await loadMessages(id)).filter(m => m.uuid === userMessageId).length, 1)
    assert.equal(call, 4)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('approval survives a durable pause/resume; busy targets reject and idle changes revoke grants', async () => {
  const id = `task-test-${randomUUID()}`
  const controller = new AbortController()
  let o: Orchestrator
  let call = 0
  const runner = { run: async (_id: string, _input: string, state: WorldState, _signal?: AbortSignal, _event?: unknown, _metric?: unknown, _message?: string, turn?: TurnContext): Promise<AgentResult> => {
    call++
    if (call === 1) return { action: 'confirm', prompt: 'full', message: 'short', confirmType: 'allow_write' }
    assert.equal(canWriteTask(state, turn!), true)
    await assert.rejects(o.setAllowedPaths([resolve('changed')]), /运行期间/)
    await assert.rejects(o.setRepositoryConfig({ repoUrl: 'https://example.test/new' }), /运行期间/)
    if (call === 2) controller.abort()
    return { action: 'chat', message: 'progress' }
  } }
  o = new Orchestrator(id, undefined, undefined, runner)
  try {
    await o.handleUserInput('A')
    const stale = o.bindInput('确认')
    await assert.rejects(o.handleUserInput('确认', undefined, controller.signal, undefined, stale), { name: 'AbortError' })
    const disk = (await loadOrchestratorState(id))!
    assert.equal(disk.task!.phase, 'paused')
    assert.ok(disk.task!.approval)
    o = new Orchestrator(id, disk, undefined, runner)
    await o.handleUserInput('继续')
    assert.equal(o.state.task!.phase, 'active') // chat ends run, not task
    await assert.rejects(o.handleUserInput('确认', undefined, undefined, undefined, stale), /方案/)
    await o.setAllowedPaths([resolve('changed')])
    assert.equal(o.state.task!.approval, undefined)
    assert.equal(o.state.task!.phase, 'paused')
  } finally { await rm(resolve('state', id), { recursive: true, force: true }) }
})

test('waiting answers revise, clearConfirmation validates identity, and done is task completion', async () => {
  const id = `task-test-${randomUUID()}`
  const results: AgentResult[] = [{ action: 'ask_user', questions: ['where?'] }, { action: 'confirm', prompt: 'full proposal' }, { action: 'done', message: 'finished' }]
  const o = new Orchestrator(id, undefined, undefined, { run: async () => results.shift()! })
  try {
    await o.handleUserInput('A')
    const original = o.state.task!.id
    await o.handleUserInput('README only')
    assert.equal(o.state.task!.id, original)
    assert.equal(o.state.task!.revision, 2)
    const p = o.state.task!.pendingConfirmation!
    await assert.rejects(o.clearConfirmation({ taskId: original, taskRevision: 1, confirmationId: p.id }), /方案/)
    assert.equal(o.state.task!.pendingConfirmation!.prompt, 'full proposal')
    await o.handleUserInput('确认')
    assert.equal(o.state.task!.phase, 'completed')
    assert.equal(o.state.task!.approval, undefined)
  } finally { await rm(resolve('state', id), { recursive: true, force: true }) }
})

test('callbacks retained by a finished runner cannot publish late output', async () => {
  const id = `task-test-${randomUUID()}`
  let retained: AgentEventHandler | undefined
  const events: string[] = []
  const o = new Orchestrator(id, undefined, undefined, { run: async (_id, _input, _state, _signal, onEvent) => {
    retained = onEvent
    return { action: 'chat', message: 'normal' }
  } })
  try {
    await o.handleUserInput('A', event => { if (event.type === 'output') events.push(event.message) })
    await retained!({ type: 'output', message: 'late' })
    assert.equal(events.includes('late'), false)
  } finally { await rm(resolve('state', id), { recursive: true, force: true }) }
})
