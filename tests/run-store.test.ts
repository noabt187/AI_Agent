import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunStore } from '../src/state/runStore.js'
import { sessionTimeline } from '../web/src/sessionTimeline.js'

test('cancelled runs survive reload, terminal status wins, pending runs recover as interrupted', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-runs-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new RunStore(dir)
  const run = await store.create('s1', 'first')
  await store.update('s1', run.id, { status: 'running' })
  await store.update('s1', run.id, { status: 'cancelled', partialOutput: 'partial', messageIds: ['u1'] })
  assert.equal((await store.update('s1', run.id, { status: 'completed' })).status, 'cancelled')
  const pending = await store.create('s1', 'second')
  assert.equal((await store.list('s1'))[1].status, 'queued')
  const reloaded = await new RunStore(dir).list('s1')
  assert.equal(reloaded[0].status, 'cancelled')
  assert.equal(reloaded[1].id, pending.id)
  assert.equal(reloaded[1].status, 'interrupted')
  const timeline = sessionTimeline([{ uuid: 'u1', role: 'user', content: 'first', createdAt: run.createdAt }], reloaded)
  assert.equal(timeline.filter(item => item.content === 'first').length, 1)
  assert.ok(timeline.some(item => item.content === 'partial'))
  assert.ok(timeline.some(item => item.content === '操作已取消'))
  assert.deepEqual(sessionTimeline([{ uuid: 'old', role: 'assistant', content: 'legacy', createdAt: 0 }]).map(x => x.content), ['legacy'])
})

test('concurrent creates and updates do not overwrite runs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-runs-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new RunStore(dir)
  const runs = await Promise.all(Array.from({ length: 10 }, (_, n) => store.create('s2', String(n))))
  await Promise.all(runs.map(run => store.update('s2', run.id, { status: 'completed' })))
  assert.equal((await store.list('s2')).filter(run => run.status === 'completed').length, 10)
})

test('optional display metadata survives reload without overriding terminal results', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-runs-meta-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new RunStore(dir)
  const run = await store.create('s', 'plan')
  await store.update('s', run.id, { origin: 'plugin', resultMeta: { action: 'chat', protocolFallback: true } })
  await store.update('s', run.id, { status: 'completed' })
  await store.update('s', run.id, { resultMeta: { action: 'done' } })
  const loaded = (await new RunStore(dir).list('s'))[0]
  assert.equal(loaded.origin, 'plugin')
  assert.deepEqual(loaded.resultMeta, { action: 'chat', protocolFallback: true })
  const legacy = await store.create('s', 'legacy')
  assert.equal(legacy.origin, undefined)
  assert.equal(legacy.resultMeta, undefined)
})
