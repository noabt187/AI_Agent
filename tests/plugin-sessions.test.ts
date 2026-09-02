import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { Orchestrator } from '../src/orchestrator/orchestrator.js'
import { bootPluginHost } from '../src/plugins/host.js'
import { sessionStorePlugin } from '../src/plugins/services/sessions.js'

const fixtureBaseUrl = pathToFileURL(`${import.meta.dirname}/`).href

test('ctx.sessions returns a stable live object with a dynamic authorized cwd', async () => {
  const host = await bootPluginHost({
    baseUrl: fixtureBaseUrl,
    entries: [{ id: 'sessions', name: 'cordis:sessions' }],
    builtins: { sessions: sessionStorePlugin },
  })
  const orchestrator = new Orchestrator('session-001', {
    sessionId: 'session-001',
    allowedPaths: ['D:\\workspace'],
    memorySettings: { recallMode: 'auto' },
    completedTaskIds: [],
    failedTaskIds: [],
  })
  const detach = host.ctx.sessions.attach('session-001', orchestrator, 1725235200000)
  const first = host.ctx.sessions.get('session-001')
  const second = host.ctx.sessions.get('session-001')
  assert.equal(first, second)
  assert.equal(first?.header.cwd, 'D:\\workspace')
  orchestrator.state.allowedPaths = ['D:\\next-workspace']
  assert.equal(first?.header.cwd, 'D:\\next-workspace')
  detach()
  assert.equal(host.ctx.sessions.get('session-001'), undefined)
  await host.dispose()
})

test('unsupported DSH Session capabilities fail with an explicit code', async () => {
  const host = await bootPluginHost({
    baseUrl: fixtureBaseUrl,
    entries: [{ id: 'sessions', name: 'cordis:sessions' }],
    builtins: { sessions: sessionStorePlugin },
  })
  const orchestrator = new Orchestrator('session-001')
  host.ctx.sessions.attach('session-001', orchestrator, 0)
  const session = host.ctx.sessions.get('session-001') as { fork(): void }
  assert.throws(
    () => session.fork(),
    error => error instanceof Error
      && 'code' in error
      && error.code === 'UNSUPPORTED_SESSION_CAPABILITY'
      && /fork/.test(error.message),
  )
  await host.dispose()
})
