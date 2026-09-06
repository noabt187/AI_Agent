import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { bootBrowserPluginRuntime } from '../web/src/plugins/runtime.js'
import { SlotOutlet } from '../web/src/plugins/SlotOutlet.js'

const clientBundlePath = resolve(import.meta.dirname, '../plugins/dsh-frontend-feedback/lib/client.js')

test('the unchanged PageCraft browser bundle activates and renders its launcher', async (t) => {
  const source = await readFile(clientBundlePath, 'utf8')
  const target = globalThis as typeof globalThis & { window?: typeof globalThis }
  const previousWindow = target.window
  target.window = globalThis
  t.after(() => {
    if (previousWindow === undefined) delete target.window
    else target.window = previousWindow
    delete (globalThis as { __ModuleLoader__?: unknown }).__ModuleLoader__
  })

  const runtime = await bootBrowserPluginRuntime({
    manifest: {
      revision: 'pagecraft-fixture',
      modules: [{
        id: 'dsh-frontend-feedback',
        url: '/plugins/dsh-frontend-feedback/client.js?rev=fixture',
        rev: 'fixture',
        inject: [
          '@deepseek-ai/dsh-client-runtime',
          '@deepseek-ai/dsh-client-ui-conversation',
        ],
      }],
    },
    loadBundle: async () => {
      Function(source)()
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
  assert.match(html, /打开 PageCraft/)
})
