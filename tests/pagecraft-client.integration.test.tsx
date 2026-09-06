import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import React, { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { deriveTaskInteraction } from '../web/src/taskInteraction.js'
import type { SessionDetail } from '../web/src/api.js'
import { installBrowserDom } from './helpers/host-browser-dom.js'

const clientBundlePath = resolve(import.meta.dirname, '../plugins/dsh-frontend-feedback/lib/client.js')

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
