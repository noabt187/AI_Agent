import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installBrowserDom } from './helpers/host-browser-dom.js'
import { TaskInteractionHost } from '../web/src/TaskInteractionHost.js'
import { useTaskInteractionActions } from '../web/src/useTaskInteractionActions.js'
import { deriveTaskInteraction } from '../web/src/taskInteraction.js'
import type { SessionDetail } from '../web/src/api.js'

export function interactionFixture(): SessionDetail {
  return { id:'host-ui', running:false, messages:[], state:{ sessionId:'host-ui', allowedPaths:[], task:{ id:'t', revision:1, objective:'目录方案', phase:'awaiting_confirmation', lastRunId:'r', previousContext:[], completedTaskIds:[], failedTaskIds:[], pendingConfirmation:{ id:'c', confirmationId:'c', taskId:'t', taskRevision:1, sourceRunId:'r', kind:'allow_write', allowWrite:true, prompt:'只修改测试目录', message:'目录方案', selections:['简约', '完整'] } } },
    runs:[{ id:'r', sessionId:'host-ui', prompt:'目录', status:'completed', createdAt:1, messageIds:[], taskId:'t', taskRevision:1, origin:'plugin' }] }
}
const idle = { running:false, aborting:false, syncing:false, submitting:false }
export function mockDialog(window: Window) {
  const proto = (window as any).HTMLDialogElement.prototype
  proto.showModal = function () { this.setAttribute('open', '') }
  proto.close = function () { this.removeAttribute('open') }
}
test('host dialog owns focus/Escape/drafts, uses versioned actions, and locks duplicate submissions', async () => {
  const dom = installBrowserDom(); mockDialog(dom.window)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const calls: unknown[][] = []
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  let current = deriveTaskInteraction(interactionFixture(), idle)!
  let escaped = 0
  window.addEventListener('keydown', () => { escaped++ })
  function Harness() {
    const actions = useTaskInteractionActions({ interaction:current, getCurrent:()=>current,
      submit:async (...args) => { calls.push(args); await gate }, refresh:async () => {},
      revoke:async () => { calls.push(['revoke']) }, stop:async () => { calls.push(['stop']) } })
    return <TaskInteractionHost interaction={current} actions={actions} onRefresh={async () => {}} />
  }
  const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent === text)!
  try {
    await act(async () => { root.render(<Harness />) })
    const dialog = document.querySelector('dialog')!
    assert.equal(dialog.open, true)
    assert.equal(document.activeElement?.tagName, 'H2')
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true, isComposing:true })) })
    assert.equal(dialog.open, true); assert.equal(escaped, 0)
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true })) })
    assert.equal(dialog.open, false); assert.equal(calls.length, 0); assert.equal(escaped, 0)
    assert.match(document.querySelector('[data-host-task-status]')!.textContent!, /等待确认/)
    await act(async () => { root.render(<Harness />) })
    assert.equal(dialog.open, false, 'polls never reopen a dismissed interaction')
    await act(async () => { button('查看详情').click() })
    await act(async () => { (document.querySelector('input[value="完整"]') as HTMLInputElement).click() })
    await act(async () => { button('确认执行').click(); button('确认执行').click() })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], ['host-ui', '确认', { kind:'confirm', taskId:'t', taskRevision:1, confirmationId:'c', selection:'完整' }])
    const other = interactionFixture(); other.id = 'other'; other.state.sessionId = 'other'; other.runs![0].sessionId = 'other'
    current = deriveTaskInteraction(other, idle)!
    await act(async () => { root.render(<Harness />); release(); await gate })
    assert.equal(calls.length, 1, 'late completion never acts on the next session')
  } finally { release(); await act(async () => { root.unmount() }); dom.cleanup() }
})

test('hidden-page confirmation waits for refresh; dismissed interactions do not reopen on visibility changes', async () => {
  const dom = installBrowserDom(); mockDialog(dom.window)
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  let visible = false, refreshed = 0, release!: () => void
  Object.defineProperty(document, 'visibilityState', { configurable:true, get:()=>visible ? 'visible' : 'hidden' })
  const gate = new Promise<void>(r => { release = r })
  const current = deriveTaskInteraction(interactionFixture(), idle)!
  function Harness() {
    const actions = useTaskInteractionActions({ interaction:current, getCurrent:()=>current,
      submit:async () => { assert.fail('visibility cannot submit') }, revoke:async () => { assert.fail('cancel cannot revoke') }, stop:async () => { assert.fail('cancel cannot stop') }, refresh:async () => {} })
    return <TaskInteractionHost interaction={current} actions={actions} onRefresh={async () => { refreshed++; await gate }} />
  }
  try {
    await act(async () => root.render(<Harness />))
    assert.equal(document.querySelector('dialog')!.open, false)
    await act(async () => { visible = true; document.dispatchEvent(new Event('visibilitychange')) })
    assert.equal(refreshed, 1); assert.equal(document.querySelector('dialog')!.open, false)
    await act(async () => { release(); await gate })
    assert.equal(document.querySelector('dialog')!.open, true)
    await act(async () => document.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable:true })))
    assert.equal(document.querySelector('dialog')!.open, false)
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    assert.equal(refreshed, 2); assert.equal(document.querySelector('dialog')!.open, false)
  } finally { release(); await act(async () => root.unmount()); dom.cleanup() }
})

test('protocol fallback offers explicit read-only replanning, normal chat never auto-opens', async () => {
  const dom = installBrowserDom(); mockDialog(dom.window)
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const d = interactionFixture(); d.state.task!.phase = 'active'; d.state.task!.pendingConfirmation = undefined
  d.runs![0].resultMeta = { action:'chat', protocolFallback:true }
  let current = deriveTaskInteraction(d, idle)!
  const calls: unknown[][] = []
  function Harness() {
    const actions = useTaskInteractionActions({ interaction:current, getCurrent:()=>current,
      submit:async (...args) => { calls.push(args) }, revoke:async () => { assert.fail('no confirmation') }, stop:async () => { assert.fail('not running') }, refresh:async () => {} })
    return <TaskInteractionHost interaction={current} actions={actions} onRefresh={async () => {}} />
  }
  try {
    await act(async () => root.render(<Harness />))
    assert.equal(document.querySelector('dialog')!.open, true)
    assert.equal([...document.querySelectorAll('button')].some(b => b.textContent === '确认执行'), false)
    await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === '请求重新给出方案')!.click())
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0][2], { kind:'followup', taskId:'t', taskRevision:1, sourceRunId:'r' })
    assert.match(String(calls[0][1]), /不修改文件、不执行生成/)
    await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === '收起')!.click())
    d.runs![0].resultMeta = { action:'chat' }; current = deriveTaskInteraction(d, idle)!
    await act(async () => root.render(<Harness />))
    assert.equal(document.querySelector('dialog')!.open, false)
  } finally { await act(async () => root.unmount()); dom.cleanup() }
})
