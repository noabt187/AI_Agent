import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { installBrowserDom } from './helpers/browserDom.js'
import type { SessionDetail } from '../web/src/api.js'

const ref = { taskId: 'task-A', taskRevision: 2, confirmationId: 'proposal-2' }
const proposal = { ...ref, id: ref.confirmationId, kind: 'allow_write' as const, allowWrite: true, prompt: '完整方案正文（不能丢失）', message: '简短摘要', sourceRunId: 'previous' }
const initial: SessionDetail = { id: 'A', title: 'Session A', running: false, messages: [], state: {
  sessionId: 'A', allowedPaths: ['D:/workspace'],
  task: { id: 'task-A', revision: 2, objective: 'A objective', phase: 'awaiting_confirmation', previousContext: [], completedTaskIds: [], failedTaskIds: [], pendingConfirmation: proposal },
} }
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
function gate<T>() { let release!: (value: T) => void; const promise = new Promise<T>(r => { release = r }); return { promise, release } }

test('mounted App sends the displayed proposal identity for confirm, revise, cancel and resume', async t => {
  const dom = installBrowserDom()
  const globals = globalThis as unknown as { React?: typeof React }
  globals.React = React
  const oldFetch = globalThis.fetch
  const requests: { url: string; body: any }[] = []
  let detail = structuredClone(initial)
  let pendingCancel: ReturnType<typeof gate<Response>> | undefined
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/plugins/client-manifest') return json({ revision: 'none', modules: [] })
    if (url === '/api/sessions') return json({ sessions: [{ id: 'A', title: 'Session A', updatedAt: 2 }, { id: 'B', title: 'Session B', updatedAt: 1 }] })
    if (url === '/api/skills') return json({ skills: [] })
    if (url.endsWith('/memory')) return json({ settings: { recallMode: 'off' }, projectInfo: { key: 'x', displayName: 'x', rootDir: 'D:/workspace' }, layers: [] })
    if (url.endsWith('/stream')) { requests.push({ url, body: JSON.parse(String(init?.body)) }); return json({ error: '方案已改变，请重新查看' }, 409) }
    if (url.endsWith('/pending-confirm')) { requests.push({ url, body: JSON.parse(String(init?.body)) }); return pendingCancel ? pendingCancel.promise : json({ error: '方案已改变，请重新查看' }, 409) }
    if (url === '/api/sessions/A') return json(detail)
    if (url === '/api/sessions/B') return json({ ...initial, id: 'B', title: 'Session B', state: { sessionId: 'B', allowedPaths: [], task: { ...initial.state.task, id: 'task-B', objective: 'B objective', phase: 'paused', pendingConfirmation: undefined } } })
    throw new Error(`Unexpected request ${url}`)
  }
  const [{ createRoot }, { App }, { bootBrowserPluginRuntime }] = await Promise.all([import('react-dom/client'), import('../web/src/App.js'), import('../web/src/plugins/runtime.js')])
  const runtime = await bootBrowserPluginRuntime()
  const container = dom.document.createElement('div'); dom.document.body.append(container)
  const root = createRoot(container)
  t.after(async () => { await act(async () => root.unmount()); await runtime.dispose(); container.remove(); globalThis.fetch = oldFetch; delete globals.React; dom.cleanup() })
  const click = async (text: string) => { const button = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === text); assert.ok(button, `button ${text}`); await act(async () => button.click()) }
  const render = async (key: string) => { await act(async () => root.render(<App key={key} pluginRuntime={runtime} />)) }
  await render('confirm')
  assert.match(container.textContent!, /完整方案正文（不能丢失）/)
  await click('确认执行')
  assert.deepEqual(requests.at(-1)?.body.control, { kind: 'confirm', ...ref })
  assert.match(container.textContent!, /完整方案正文（不能丢失）/, 'rejection must retain proposal')
  assert.match(container.textContent!, /方案已改变/)
  await click('继续调整')
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea[placeholder="输入你想调整的内容"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '只读取 README'); textarea.dispatchEvent(new Event('input', { bubbles: true })) })
  await click('提交修改')
  assert.deepEqual(requests.at(-1)?.body.control, { kind: 'revise', ...ref })
  assert.match(requests.at(-1)?.body.prompt, /只读取 README/)
  await click('返回')
  await click('取消')
  assert.deepEqual(requests.at(-1)?.body, { expected: ref })
  assert.match(container.textContent!, /完整方案正文（不能丢失）/)
  // A's delayed cancellation response must never replace the newly selected B.
  pendingCancel = gate<Response>()
  await click('取消')
  const rowB = [...container.querySelectorAll<HTMLElement>('[class*="session"]')].find(el => el.textContent?.trim() === 'Session B')!
  assert.ok(rowB)
  await act(async () => rowB.click())
  await act(async () => pendingCancel!.release(json(initial)))
  await click('继续任务')
  assert.equal(requests.at(-1)?.url, '/api/sessions/B/stream')
  assert.deepEqual(requests.at(-1)?.body.control, { kind: 'resume', taskId: 'task-B', taskRevision: 2 })
  // Candidate text is the exact canonical selection, not reconstructed prose.
  detail = structuredClone(initial)
  detail.state.task!.pendingConfirmation!.selections = ['选项甲：只读', '选项乙：写入']
  dom.window.sessionStorage.clear()
  await render('selection')
  await click('选项乙：写入')
  await click('确认执行')
  assert.deepEqual(requests.at(-1)?.body, { prompt: '确认', control: { kind: 'confirm', ...ref, selection: '选项乙：写入' } })
  detail = structuredClone(initial)
  detail.state.task!.pendingConfirmation!.allowWrite = false
  detail.state.task!.pendingConfirmation!.kind = 'read_only'
  await render('read-only')
  assert.doesNotMatch(container.textContent!, /Agent 将获得文件写入权限/)
  await click('确认执行')
  assert.deepEqual(requests.at(-1)?.body.control, { kind: 'confirm', ...ref })
  detail.state.task!.phase = 'paused'
  detail.state.task!.approvedProposal = { ...proposal, selection: '选项乙：写入', selections: ['选项甲：只读', '选项乙：写入'] }
  detail.state.task!.pendingConfirmation = undefined
  await render('approved')
  assert.match(container.textContent!, /已确认方案：选项乙：写入/)
  await click('继续任务')
  assert.deepEqual(requests.at(-1)?.body.control, { kind: 'resume', taskId: 'task-A', taskRevision: 2 })
})
