import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import type { SessionDetail } from '../web/src/api.js'
import type { BrowserPluginRuntime } from '../web/src/plugins/runtime.js'
import { installBrowserDom } from './helpers/browserDom.js'

const pagecraftBundlePath = resolve(import.meta.dirname, '../plugins/dsh-frontend-feedback/lib/client.js')

const session: SessionDetail = {
  id: 'session-exit',
  title: 'Exit isolation',
  running: true,
  state: {
    sessionId: 'session-exit',
    allowedPaths: ['D:/workspace'],
  },
  messages: [],
  runs: [{
    id: 'run-exit',
    sessionId: 'session-exit',
    prompt: 'Keep running',
    status: 'running',
    createdAt: 1,
    startedAt: 2,
    messageIds: [],
  }],
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  })
}

async function settleUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    if (predicate()) return
  }
  assert.fail('App did not reach the expected DOM state')
}

test('Escape exits PageCraft without aborting the running Agent; only Stop aborts it', async (t) => {
  const browser = installBrowserDom()
  const reactTarget = globalThis as unknown as { React?: typeof React }
  const previousReact = reactTarget.React
  reactTarget.React = React
  const previousFetch = globalThis.fetch
  let runtime: BrowserPluginRuntime | undefined
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  t.after(async () => {
    if (root) act(() => root?.unmount())
    container?.remove()
    await runtime?.dispose()
    delete (globalThis as { __ModuleLoader__?: unknown }).__ModuleLoader__
    delete (browser.window as unknown as { __ModuleLoader__?: unknown }).__ModuleLoader__
    globalThis.fetch = previousFetch
    if (previousReact === undefined) delete reactTarget.React
    else reactTarget.React = previousReact
    browser.cleanup()
  })
  browser.window.localStorage.clear()
  browser.window.sessionStorage.clear()

  const pagecraftSource = await readFile(pagecraftBundlePath, 'utf8')
  const requests: Array<{ url: string; method: string }> = []
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? (typeof input === 'string' || input instanceof URL ? 'GET' : input.method)
    requests.push({ url, method })
    if (url === '/api/plugins/client-manifest') {
      return jsonResponse({
        revision: 'pagecraft-exit-fixture',
        modules: [{
          id: 'dsh-frontend-feedback',
          url: '/plugins/dsh-frontend-feedback/client.js?rev=fixture',
          rev: 'fixture',
          inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-conversation'],
        }],
      })
    }
    if (url === '/api/sessions') return jsonResponse({ sessions: [{ id: session.id, title: session.title, updatedAt: 3 }] })
    if (url === `/api/sessions/${session.id}`) return jsonResponse(session)
    if (url === `/api/sessions/${session.id}/memory`) {
      return jsonResponse({
        settings: { recallMode: 'auto' },
        projectInfo: { key: 'fixture', displayName: 'Fixture', rootDir: 'D:/workspace' },
        layers: [],
      })
    }
    if (url === '/api/skills') return jsonResponse({ skills: [] })
    if (url === `/api/sessions/${session.id}/abort` && method === 'POST') return jsonResponse({ ok: true })
    throw new Error(`Unexpected ${method} request: ${url}`)
  }

  const [{ createRoot }, { App }, { bootBrowserPluginRuntime }] = await Promise.all([
    import('react-dom/client'),
    import('../web/src/App.js'),
    import('../web/src/plugins/runtime.js'),
  ])
  runtime = await bootBrowserPluginRuntime({
    loadBundle: async () => {
      ;(browser.window as unknown as { __ModuleLoader__?: unknown }).__ModuleLoader__ =
        (globalThis as { __ModuleLoader__?: unknown }).__ModuleLoader__
      Function(pagecraftSource)()
    },
  })

  container = browser.document.createElement('div')
  browser.document.body.append(container)
  root = createRoot(container)

  await act(async () => { root.render(<App pluginRuntime={runtime} />) })
  await settleUntil(() => browser.document.querySelector('button[title="停止"]') !== null)

  const abortUrls = () => requests
    .filter(({ url, method }) => method === 'POST' && url.endsWith('/abort'))
    .map(({ url }) => url)
  const dispatchEscape = (target: EventTarget) => {
    const BrowserKeyboardEvent = (browser.window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent
    target.dispatchEvent(new BrowserKeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  }

  await act(async () => { dispatchEscape(browser.window) })
  const composer = browser.document.querySelector<HTMLTextAreaElement>('form.composer textarea')!
  await act(async () => { dispatchEscape(composer) })

  const launcher = browser.document.querySelector<HTMLButtonElement>('button[aria-label="打开 PageCraft"]')!
  await act(async () => { launcher.click() })
  const dialogInput = browser.document.querySelector<HTMLInputElement>('[role="dialog"][aria-label="PageCraft"] input[aria-label="预览地址"]')!
  assert.ok(dialogInput, 'the real PageCraft bundle should render its preview-address input')
  await act(async () => { dispatchEscape(dialogInput) })

  assert.deepEqual(abortUrls(), [])
  assert.ok(browser.document.querySelector('button[title="停止"]'), 'Escape must retain the running state')
  assert.equal(composer.disabled, true, 'the running composer remains disabled')

  const stop = browser.document.querySelector<HTMLButtonElement>('button[title="停止"]')!
  await act(async () => { stop.click() })
  assert.deepEqual(abortUrls(), ['/api/sessions/session-exit/abort'])
})
