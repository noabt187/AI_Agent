import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BrowserSessionService } from '../web/src/plugins/sessions.js'
import { Context } from '@deepseek-ai/cordis'
import { bootBrowserPluginRuntime } from '../web/src/plugins/runtime.js'
import { SlotOutlet } from '../web/src/plugins/SlotOutlet.js'

afterEach(() => {
  delete (globalThis as { __ModuleLoader__?: unknown }).__ModuleLoader__
})

test('browser session facade exposes DSH queue semantics and observable running state', async (t) => {
  const ctx = new Context()
  await ctx.plugin(BrowserSessionService)
  t.after(() => ctx.fiber.dispose())
  let running = false
  const prompts: string[] = []
  const seen: boolean[] = []
  const dispose = ctx.sessions.bind('session-001', {
    getRunning: () => running,
    prompt: async text => { prompts.push(text); return { ok: true } },
  })
  const session = ctx.sessions.binding('session-001')?.session
  session?.subscribe(() => { seen.push(Boolean(session.getSnapshot().running)) })
  assert.deepEqual(await session?.prompt([{ type: 'text', text: '[frontend-feedback] {}' }], 'queue'), { ok: true })
  assert.deepEqual(prompts, ['[frontend-feedback] {}'])
  running = true
  ctx.sessions.notifyRunningChanged('session-001')
  ctx.sessions.notifyRunningChanged('session-001')
  assert.deepEqual(seen, [true])
  dispose()
  assert.equal(ctx.sessions.binding('session-001'), undefined)
})

test('runtime activates a client plugin against slots and sessions', async (t) => {
  const runtime = await bootBrowserPluginRuntime({
    manifest: {
      revision: 'fixture',
      modules: [{ id: 'pagecraft-probe', url: '/pagecraft-probe.js', rev: 'abc', inject: ['slots', 'sessions'] }],
    },
    loadBundle: async () => {
      globalThis.__ModuleLoader__!.load({
        id: 'pagecraft-probe',
        factory: require => {
          const hostReact = require('react') as typeof React
          const Launcher = () => hostReact.createElement('button', { type: 'button' }, 'PageCraft')
          return {
            inject: ['slots', 'sessions'],
            apply(ctx: Context) {
              ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
                name: 'conversation.input.left',
                id: 'pagecraft',
                inject: (sessionId: string) => ({ sessionId }),
              }, Launcher))
            },
          }
        },
      })
    },
  })
  t.after(() => runtime.dispose())
  runtime.sessions.bind('session-001', {
    getRunning: () => false,
    prompt: async () => ({ ok: true }),
  })
  const html = renderToStaticMarkup(
    <SlotOutlet runtime={runtime} name="conversation.input.left" sessionId="session-001" owner={{}} />,
  )
  assert.match(html, /PageCraft/)
})
