import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import React, { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { deriveTaskInteraction } from '../web/src/taskInteraction.js'
import type { SessionDetail } from '../web/src/api.js'
import { installBrowserDom } from './helpers/host-browser-dom.js'
import { previewUrlStorageKey } from '../plugins/dsh-frontend-feedback/src/shared.js'
import { presentationStorageKey } from '../plugins/dsh-frontend-feedback/src/presentation.js'

const clientBundlePath = resolve(import.meta.dirname, '../plugins/dsh-frontend-feedback/lib/client.js')

const bindingSession = 'qa-presentation-binding'
const bindingId = 'presentation-binding-12345678'
const bindingPreview = 'http://localhost:5000/'

async function mountPresentationBinding(t: TestContext, options: {
  resolveResponse?: () => Promise<Response>
  storedId?: string
} = {}) {
  const dom = installBrowserDom()
  const oldFetch = globalThis.fetch
  const oldEvents = Object.getOwnPropertyDescriptor(globalThis, 'EventSource')
  const requests: URL[] = []
  let cleanup: (() => Promise<void>) | undefined
  t.after(async () => {
    try { await cleanup?.() } finally {
      globalThis.fetch = oldFetch
      if (oldEvents) Object.defineProperty(globalThis, 'EventSource', oldEvents)
      else Reflect.deleteProperty(globalThis, 'EventSource')
      dom.cleanup()
    }
  })
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, writable: true,
    value: class { addEventListener() {} close() {} } })
  // These tests open the directory, not editable documents. Draft persistence
  // is covered by the plugin suite; fail if this read-only flow starts using it.
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: {
    open() {
      const request = {} as IDBOpenDBRequest
      queueMicrotask(() => {
        Object.defineProperty(request, 'result', { value: {
          transaction() { assert.fail('opening a directory must not read or write document drafts') },
        } })
        request.onsuccess?.call(request, new Event('success'))
      })
      return request
    },
  } })
  window.localStorage.setItem(previewUrlStorageKey(`${bindingSession}:presentation`), bindingPreview)
  if (options.storedId) window.localStorage.setItem(presentationStorageKey(bindingSession), options.storedId)
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method ?? 'GET', 'GET', 'opening the workspace must not write files')
    const url = new URL(String(input), 'http://127.0.0.1:4173')
    requests.push(url)
    assert.equal(url.searchParams.get('sessionId'), bindingSession)
    if (url.pathname.endsWith('/presentation/resolve')) {
      assert.equal(url.searchParams.get('url'), bindingPreview)
      return options.resolveResponse?.() ?? Response.json({ presentationId: bindingId })
    }
    if (url.pathname.endsWith('/presentation-workspace')) {
      assert.equal(url.searchParams.get('presentationId'), bindingId)
      return Response.json({ available: true, presentationId: bindingId, workspacePath: '/fixture', manifest: {
        presentationId: bindingId, name: 'Binding fixture', entry: 'src/presentation/index.html',
        sourceRoot: 'src/presentation', deck: 'src/presentation/deck.json', theme: 'src/presentation/theme.css',
        assets: 'public/pagecraft-assets', publicAssetBase: '/pagecraft-assets',
        editableFiles: ['src/presentation/deck.json', 'src/presentation/theme.css'],
      } })
    }
    if (url.pathname.endsWith('/workspace')) {
      const selectedFolder = url.searchParams.get('selectedFolder') ?? '.'
      return Response.json({ rootPath: '/fixture', selectedFolder,
        selectedPath: selectedFolder === '.' ? '/fixture' : `/fixture/${selectedFolder}`, watcher: 'connected', sequence: 0 })
    }
    if (url.pathname.endsWith('/workspace/directory')) {
      assert.equal(url.searchParams.get('selectedFolder'), 'src/presentation')
      return Response.json([{ name: 'deck.json', path: 'src/presentation/deck.json', kind: 'file',
        textEditable: true, imagePreviewable: false, updatedAt: '' }])
    }
    assert.fail(`Unexpected request: ${url}`)
  }
  const [{ bootBrowserPluginRuntime }, { SlotOutlet }, { createRoot }] = await Promise.all([
    import('../web/src/plugins/runtime.js'), import('../web/src/plugins/SlotOutlet.js'), import('react-dom/client'),
  ])
  const source = await readFile(clientBundlePath, 'utf8')
  const runtime = await bootBrowserPluginRuntime({
    manifest: { revision: 'binding', modules: [{ id: 'dsh-frontend-feedback', url: '/binding-client.js', rev: 'binding' }] },
    loadBundle: async () => { (dom.window as any).__ModuleLoader__ = globalThis.__ModuleLoader__; Function(source)() },
  })
  runtime.sessions.bind(bindingSession, { getRunning: () => false, prompt: async () => {
    assert.fail('binding and opening files must not send an Agent prompt')
  } })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  cleanup = async () => { await act(async () => root.unmount()); await runtime.dispose() }
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) }) }
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)
    assert.ok(button, `button ${label} exists`)
    await act(async () => button.click())
    await settle()
  }
  const previewReady = async (id: string) => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="前端页面评注预览"]')
    assert.ok(frame?.contentWindow)
    await act(async () => {
      window.dispatchEvent(new (dom.window as any).MessageEvent('message', {
        source: frame.contentWindow, data: { type: 'dsh-frontend-feedback-ready', presentationId: id },
      }))
    })
  }
  await act(async () => { root.render(<SlotOutlet runtime={runtime} name="conversation.input.left" sessionId={bindingSession} owner={{}} />) })
  await click('打开 PageCraft')
  await click('演示文稿')
  return { requests, click, settle, previewReady }
}

test('real PageCraft bundle awaits legacy ID resolution and opens the bound source directory', async t => {
  let resolveResponse!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { resolveResponse = resolve })
  const f = await mountPresentationBinding(t, { resolveResponse: () => pending })
  assert.equal(window.localStorage.getItem(presentationStorageKey(bindingSession)), null)
  await act(async () => resolveResponse(Response.json({ presentationId: bindingId })))
  await f.settle()
  assert.equal(window.localStorage.getItem(presentationStorageKey(bindingSession)), bindingId)
  assert.ok(f.requests.some(url => url.pathname.endsWith('/presentation-workspace')), 'automatic workspace loading follows ID resolution')
  assert.doesNotMatch(document.body.textContent ?? '', /response\.json is not a function|无法确认 PPT 项目图片目录/)
  const frame = document.querySelector<HTMLIFrameElement>('iframe[title="前端页面评注预览"]')!
  assert.equal(new URL(frame.src).searchParams.get('presentationId'), bindingId)
  await f.previewReady(bindingId)
  await f.click('文件')
  const workspace = document.querySelector('[data-pagecraft-source-workspace]')
  assert.ok(workspace, 'the file button actually mounts the real source workspace')
  assert.match(workspace.textContent ?? '', new RegExp(bindingId))
  assert.match(workspace.textContent ?? '', /已通过.*绑定 PPT 源码/)
  assert.match(workspace.textContent ?? '', /deck\.json/)
  assert.ok(f.requests.some(url => url.pathname.endsWith('/workspace/directory') && url.searchParams.get('selectedFolder') === 'src/presentation'))
})

test('real PageCraft bundle loads a persisted ID but blocks files until preview identity matches', async t => {
  const f = await mountPresentationBinding(t, { storedId: bindingId })
  assert.ok(f.requests.some(url => url.pathname.endsWith('/presentation-workspace')))
  assert.equal(f.requests.some(url => url.pathname.endsWith('/presentation/resolve')), false)
  await f.previewReady('presentation-other-12345678')
  await f.click('文件')
  assert.equal(document.querySelector('[data-pagecraft-source-workspace]'), null)
  assert.match(document.body.textContent ?? '', /尚未完成身份核对/)
  await f.previewReady(bindingId)
  await f.click('文件')
  assert.ok(document.querySelector('[data-pagecraft-source-workspace]'))
})

for (const failure of [
  { name: 'HTTP ambiguity', response: () => Promise.resolve(Response.json({ error: { message: '多个 PPT 使用相同预览地址' } }, { status: 409 })), message: /多个 PPT 使用相同预览地址/ },
  { name: 'invalid ID response', response: () => Promise.resolve(Response.json({})), message: /服务端未返回有效的 presentationId/ },
  { name: 'network rejection', response: () => Promise.reject(new Error('network unavailable')), message: /network unavailable/ },
]) {
  test(`real PageCraft bundle reports ${failure.name} without silently accepting a binding`, async t => {
    const f = await mountPresentationBinding(t, { resolveResponse: failure.response })
    assert.match(document.body.textContent ?? '', /无法自动绑定 PPT/)
    assert.match(document.body.textContent ?? '', failure.message)
    assert.equal(window.localStorage.getItem(presentationStorageKey(bindingSession)), null)
    assert.equal(f.requests.some(url => url.pathname.endsWith('/presentation-workspace')), false)
    assert.equal(document.querySelector('[data-pagecraft-source-workspace]'), null)
  })
}

test('unchanged PageCraft document draft stays mounted below host confirmation and fallback dialogs', async t => {
  const dom = installBrowserDom()
  const [{ bootBrowserPluginRuntime }, { SlotOutlet }, { TaskInteractionHost }, { useTaskInteractionActions }] = await Promise.all([
    import('../web/src/plugins/runtime.js'), import('../web/src/plugins/SlotOutlet.js'),
    import('../web/src/TaskInteractionHost.js'), import('../web/src/useTaskInteractionActions.js'),
  ])
  const proto = (dom.window as any).HTMLDialogElement.prototype
  proto.showModal = function () { this.setAttribute('open', '') }
  proto.close = function () { this.removeAttribute('open') }
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('{}', { headers:{ 'Content-Type':'application/json' } })
  const source = await readFile(clientBundlePath, 'utf8')
  const runtime = await bootBrowserPluginRuntime({ manifest:{ revision:'dialog-fixture', modules:[{ id:'dsh-frontend-feedback', url:'/fixture-client.js', rev:'fixture' }] },
    loadBundle:async () => { (dom.window as any).__ModuleLoader__ = globalThis.__ModuleLoader__; Function(source)() } })
  let promptCalls = 0
  runtime.sessions.bind('qa-host', { getRunning:()=>false, prompt:async () => { promptCalls++; return { ok:true } } })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const detail: SessionDetail = { id:'qa-host', running:false, messages:[], state:{ sessionId:'qa-host', allowedPaths:[], task:{ id:'t', revision:1, objective:'目录方案', phase:'awaiting_confirmation', lastRunId:'r', previousContext:[], completedTaskIds:[], failedTaskIds:[], pendingConfirmation:{ id:'c', confirmationId:'c', taskId:'t', taskRevision:1, sourceRunId:'r', kind:'allow_write', allowWrite:true, prompt:'只修改测试目录', message:'方案' } } }, runs:[{ id:'r', sessionId:'qa-host', prompt:'目录', status:'completed', createdAt:1, messageIds:[], taskId:'t', taskRevision:1, origin:'plugin' }] }
  let interaction: ReturnType<typeof deriveTaskInteraction> = null
  function Harness() {
    const actions = useTaskInteractionActions({ interaction, getCurrent:()=>interaction,
      submit:async () => { promptCalls++ }, stop:async () => { assert.fail('dismiss must not abort') }, revoke:async () => { assert.fail('dismiss must not revoke') }, refresh:async () => {} })
    return <><SlotOutlet runtime={runtime} name="conversation.input.left" sessionId="qa-host" owner={{}} /><TaskInteractionHost interaction={interaction} actions={actions} onRefresh={async () => {}} /></>
  }
  t.after(async () => { await act(async () => root.unmount()); await runtime.dispose(); globalThis.fetch = oldFetch; dom.cleanup() })
  const click = async (text: string) => {
    const node = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text || b.getAttribute('aria-label') === text)
    assert.ok(node, text); await act(async () => node.click())
  }
  await act(async () => { root.render(<Harness />) })
  await click('打开 PageCraft'); await click('演示文稿'); await click('上传文档生成')
  const draft = document.querySelector<HTMLTextAreaElement>('textarea[placeholder^="粘贴文章"]')!
  assert.ok(draft)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(draft, 'QA document draft: never submit')
    draft.dispatchEvent(new Event('input', { bubbles:true }))
  })
  interaction = deriveTaskInteraction(detail, { running:false, aborting:false, syncing:false, submitting:false })
  await act(async () => { root.render(<Harness />) })
  assert.equal(document.querySelector('dialog')!.open, true)
  assert.ok(document.querySelector('[aria-label="PageCraft"]'))
  await act(async () => { document.querySelector('dialog')!.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true })) })
  assert.equal(document.querySelector('dialog')!.open, false)
  assert.equal(document.querySelector('textarea[placeholder^="粘贴文章"]'), draft, 'the plugin draft DOM node survives host dialog changes')
  assert.equal(draft.value, 'QA document draft: never submit')
  detail.state.task!.phase = 'active'; detail.state.task!.pendingConfirmation = undefined
  detail.runs![0].resultMeta = { action:'chat', protocolFallback:true }
  interaction = deriveTaskInteraction(detail, { running:false, aborting:false, syncing:false, submitting:false })
  await act(async () => { root.render(<Harness />) })
  assert.equal(document.querySelector('dialog')!.open, true)
  assert.equal([...document.querySelectorAll('dialog button')].some(b => b.textContent === '确认执行'), false)
  await click('收起')
  assert.ok(document.querySelector('[aria-label="PageCraft"]'))
  assert.equal(promptCalls, 0)
})

test('the unchanged PageCraft browser bundle activates and renders its launcher', async (t) => {
  const [{ bootBrowserPluginRuntime }, { SlotOutlet }] = await Promise.all([import('../web/src/plugins/runtime.js'), import('../web/src/plugins/SlotOutlet.js')])
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
