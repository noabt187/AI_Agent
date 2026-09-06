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
  const previousWindowConstructor = Object.getOwnPropertyDescriptor(globalThis, 'Window')
  Object.defineProperty(globalThis, 'Window', { configurable: true, writable: true, value: browser.window.Window })
  browser.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  browser.window.Range.prototype.getBoundingClientRect = () => new browser.window.DOMRect()
  const reactTarget = globalThis as unknown as { React?: typeof React }
  const previousReact = reactTarget.React
  reactTarget.React = React
  const previousFetch = globalThis.fetch
  const previousEventSource = globalThis.EventSource
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
    globalThis.EventSource = previousEventSource
    if (previousReact === undefined) delete reactTarget.React
    else reactTarget.React = previousReact
    browser.cleanup()
    if (previousWindowConstructor) Object.defineProperty(globalThis, 'Window', previousWindowConstructor)
    else delete (globalThis as { Window?: unknown }).Window
  })
  browser.window.localStorage.clear()
  browser.window.sessionStorage.clear()
  Object.defineProperty(browser.window, 'indexedDB', {
    configurable: true,
    value: {
      open: () => {
        const request: { onsuccess?: () => void; result?: object } = {}
        queueMicrotask(() => { request.result = {}; request.onsuccess?.() })
        return request
      },
    },
  })

  const pagecraftSource = await readFile(pagecraftBundlePath, 'utf8')
  const requests: Array<{ url: string; method: string }> = []
  globalThis.EventSource = class {
    addEventListener() {}
    close() {}
  } as unknown as typeof EventSource
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
    const parsed = new URL(url, 'http://fixture')
    if (parsed.pathname === '/api/frontend-feedback/workspace') {
      return jsonResponse({ rootPath: 'D:/workspace', selectedPath: 'D:/workspace', selectedFolder: '.', watcher: 'connected', sequence: 0 })
    }
    if (parsed.pathname === '/api/frontend-feedback/workspace/directory') {
      return jsonResponse([{ path: '.env', name: '.env', kind: 'file', textEditable: true, imagePreviewable: false, bytes: 5, updatedAt: '' }])
    }
    if (parsed.pathname === '/api/frontend-feedback/workspace/file' && method === 'GET') {
      return jsonResponse({ path: '.env', content: 'base\n', hash: 'disk-base', bytes: 5, updatedAt: '', language: 'text' })
    }
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

  assert.equal(
    browser.document.querySelector('[role="dialog"][aria-label="PageCraft"]'),
    null,
    'Escape should close the PageCraft dialog',
  )
  assert.deepEqual(abortUrls(), [])
  assert.ok(browser.document.querySelector('button[title="停止"]'), 'Escape must retain the running state')
  assert.equal(composer.disabled, true, 'the running composer remains disabled')

  await act(async () => { launcher.click() })
  const fileWorkspace = Array.from(browser.document.querySelectorAll<HTMLButtonElement>('[role="dialog"][aria-label="PageCraft"] button'))
    .find(button => button.textContent === '文件')!
  assert.ok(fileWorkspace, 'the assembled bundle should expose the file workspace')
  await act(async () => { fileWorkspace.click() })
  await settleUntil(() => browser.document.querySelector('[data-pagecraft-source-workspace]') !== null)
  const sourceFile = Array.from(browser.document.querySelectorAll<HTMLButtonElement>('[data-pagecraft-source-workspace] button'))
    .find(button => button.textContent?.includes('.env'))!
  assert.ok(sourceFile, 'the real workspace should render the mocked host file')
  await act(async () => { sourceFile.click() })
  await settleUntil(() => browser.document.querySelector('.cm-content') !== null)
  type EmbeddedEditor = { state: { doc: { length: number } }; dispatch(update: { changes: { from: number; insert: string } }): void }
  const editor = (browser.document.querySelector('.cm-content') as HTMLElement & {
    cmTile?: { root?: { view?: EmbeddedEditor } }
  }).cmTile?.root?.view
  assert.ok(editor, 'the actual bundled CodeMirror view should be mounted')
  await act(async () => { editor.dispatch({ changes: { from: editor.state.doc.length, insert: 'dirty' } }) })
  await settleUntil(() => browser.document.querySelector('[data-pagecraft-source-workspace]')?.textContent?.includes('未保存') === true)

  const confirmations: string[] = []
  browser.window.confirm = message => { confirmations.push(String(message)); return false }
  const closeWorkspace = browser.document.querySelector<HTMLButtonElement>('button[aria-label="关闭文件工作区"]')!
  await act(async () => { closeWorkspace.click() })
  assert.ok(browser.document.querySelector('[data-pagecraft-source-workspace]'), 'cancel keeps the dirty workspace open')
  assert.deepEqual(confirmations, ['还有未保存的修改，确定关闭文件工作区吗？'])

  browser.window.confirm = message => { confirmations.push(String(message)); return true }
  await act(async () => { closeWorkspace.click() })
  await settleUntil(() => browser.document.querySelector('[data-pagecraft-source-workspace]') === null)
  assert.equal(confirmations.length, 2, 'confirm is required again before discarding the dirty workspace')
  assert.ok(browser.document.querySelector('[role="dialog"][aria-label="PageCraft"]'), 'confirm closes only the file workspace')
  const closePageCraft = browser.document.querySelector<HTMLButtonElement>('button[aria-label="关闭页面评注"]')!
  await act(async () => { closePageCraft.click() })
  assert.equal(browser.document.querySelector('[role="dialog"][aria-label="PageCraft"]'), null)
  assert.deepEqual(abortUrls(), [])
  assert.ok(browser.document.querySelector('button[title="停止"]'), 'dirty cancel/confirm and PageCraft close retain the running state')

  const stop = browser.document.querySelector<HTMLButtonElement>('button[title="停止"]')!
  await act(async () => { stop.click() })
  assert.deepEqual(abortUrls(), ['/api/sessions/session-exit/abort'])
})
