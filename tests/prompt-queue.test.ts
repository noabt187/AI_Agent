import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionPromptQueue, type PromptJob } from '../src/server/promptQueue.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function immediate(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

function job(sessionId: string, prompt: string): PromptJob {
  return { sessionId, prompt, onEvent() {} }
}

test('prompt jobs for one session execute FIFO while sessions remain independent', async () => {
  const order: string[] = []
  const gates = { a: deferred(), b: deferred(), c: deferred() }
  const queue = new SessionPromptQueue(async item => {
    order.push(`start:${item.prompt}`)
    await gates[item.prompt as keyof typeof gates].promise
    order.push(`end:${item.prompt}`)
  })
  const a = queue.enqueue(job('s1', 'a'))
  const b = queue.enqueue(job('s1', 'b'))
  const c = queue.enqueue(job('s2', 'c'))
  await immediate()
  assert.deepEqual(order, ['start:a', 'start:c'])
  gates.c.resolve()
  await c
  gates.a.resolve()
  await a
  await immediate()
  gates.b.resolve()
  await b
  assert.deepEqual(order, ['start:a', 'start:c', 'end:c', 'end:a', 'start:b', 'end:b'])
})

test('aborting the active prompt preserves later jobs', async () => {
  const firstGate = deferred()
  const order: string[] = []
  let aborted = false
  const queue = new SessionPromptQueue(async item => {
    order.push(item.prompt)
    if (item.prompt === 'first') await firstGate.promise
  }, () => {
    aborted = true
    firstGate.resolve()
  })
  const first = queue.enqueue(job('s1', 'first'))
  const second = queue.enqueue(job('s1', 'second'))
  await immediate()
  await queue.abort('s1')
  await Promise.all([first, second])
  assert.equal(aborted, true)
  assert.deepEqual(order, ['first', 'second'])
})

test('deleting a session rejects queued jobs and waits for the active job to settle', async () => {
  const firstGate = deferred()
  const queue = new SessionPromptQueue(async item => {
    if (item.prompt === 'first') await firstGate.promise
  }, () => { firstGate.resolve() })
  const first = queue.enqueue(job('s1', 'first'))
  const second = queue.enqueue(job('s1', 'second'))
  const deleting = queue.delete('s1')
  await assert.rejects(second, error => error instanceof Error && 'code' in error && error.code === 'SESSION_DELETED')
  await deleting
  await first
  assert.equal(queue.queued('s1'), 0)
})

test('abort waits for durable finish before allowing a queued successor', async () => {
  const executing = deferred(), durable = deferred()
  const order: string[] = []
  const queue = new SessionPromptQueue(async item => {
    if (item.prompt === 'first') await executing.promise
    order.push(item.prompt)
  }, () => executing.resolve())
  const first = queue.enqueue({ ...job('s', 'first'), onFinish: async (_error, signal) => {
    assert.equal(signal?.aborted, true)
    await durable.promise
    order.push('saved')
  } })
  const second = queue.enqueue(job('s', 'second'))
  const abort = queue.abort('s')
  await immediate()
  assert.deepEqual(order, ['first'])
  durable.resolve()
  await Promise.all([abort, first, second])
  assert.deepEqual(order, ['first', 'saved', 'second'])
})
