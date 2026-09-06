// Development-only browser fixture. Host actions are recorded in memory, never sent to a model.
import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { bootBrowserPluginRuntime } from '../src/plugins/runtime'
import { SlotOutlet } from '../src/plugins/SlotOutlet'
import { TaskInteractionHost } from '../src/TaskInteractionHost'
import { useTaskInteractionActions } from '../src/useTaskInteractionActions'
import { deriveTaskInteraction } from '../src/taskInteraction'
import type { SessionDetail, TaskInputControl } from '../src/api'
import '../src/styles.css'

if (!import.meta.env.DEV) throw new Error('QA fixture is development-only')
const liveFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url, location.href)
  if (url.pathname.startsWith('/api/frontend-feedback/')) {
    // No access to the user's project/session, and no fabricated generation results.
    return new Response(JSON.stringify({ error:{ message:'QA 夹具不提供真实项目读写' } }), { status:404, headers:{ 'Content-Type':'application/json' } })
  }
  return liveFetch(input, init)
}
const runtime = await bootBrowserPluginRuntime()
let sequence = 0
const initial = (): SessionDetail => ({ id:'qa-host-only', running:false, messages:[], state:{ sessionId:'qa-host-only', allowedPaths:[] }, runs:[] })
function Fixture() {
  const [detail, setDetail] = useState(initial), [syncing, setSyncing] = useState(false), [log, setLog] = useState<string[]>([])
  const current = useRef(detail); current.current = detail
  const running = useRef(false); running.current = detail.running
  const bound = useRef(false)
  if (!bound.current) {
    bound.current = true
    runtime.sessions.bind('qa-host-only', { getRunning:()=>running.current, prompt:async () => ({ ok:false, error:{ message:'QA 禁止向模型提交插件请求' } }) })
  }
  function update(next: SessionDetail) { current.current = next; setDetail(next); running.current = next.running; runtime.sessions.notifyRunningChanged(next.id) }
  function inject(kind: 'confirm' | 'chat' | 'ask_user' | 'running' | 'fallback') {
    const n = ++sequence, id = 'qa-host-only', rid = `qa-run-${n}`
    update({ id, running:kind === 'running', messages:[{ uuid:`m${n}`, role:'assistant', content:'QA 只读示例：建议生成三章目录，确认后再执行。此回复仅供 UI 验收。', createdAt:n }],
      state:{ sessionId:id, allowedPaths:[], task:{ id:'qa-task', revision:n, objective:'演示文稿目录 · 宿主交互验收', phase:kind === 'confirm' ? 'awaiting_confirmation' : kind === 'ask_user' ? 'awaiting_input' : 'active', lastRunId:rid, previousContext:[], completedTaskIds:[], failedTaskIds:[], questions:kind === 'ask_user' ? ['请说明听众和演讲目标。'] : undefined,
        pendingConfirmation:kind === 'confirm' ? { id:`c${n}`, confirmationId:`c${n}`, taskId:'qa-task', taskRevision:n, sourceRunId:rid, kind:'allow_write', allowWrite:true, message:'目录方案', prompt:'方案：\n1. 背景与目标\n2. 核心架构\n3. 实施步骤\n\n这次确认绑定当前方案版本，不会授权后续替代任务。', selections:['精简版 · 三章', '详细版 · 五章'] } : undefined } },
      runs:[{ id:rid, sessionId:id, prompt:'QA', status:kind === 'running' ? 'running' : 'completed', createdAt:n, messageIds:[`m${n}`], origin:'plugin', taskId:'qa-task', taskRevision:n, resultMeta:{ action:kind === 'confirm' ? 'confirm' : kind === 'ask_user' ? 'ask_user' : 'chat', ...(kind === 'fallback' ? { protocolFallback:true as const } : {}) } }] })
    setSyncing(false)
  }
  const view = deriveTaskInteraction(detail, { running:detail.running, aborting:false, syncing, submitting:false })
  const getCurrent = () => deriveTaskInteraction(current.current, { running:current.current.running, aborting:false, syncing, submitting:false })
  const record = (label: string, value: unknown) => setLog(items => [...items, `${label}: ${JSON.stringify(value)}`])
  const actions = useTaskInteractionActions({ interaction:view, getCurrent,
    submit:async (_id, text, control: TaskInputControl) => {
      record('submit', { text, control })
      const next = structuredClone(current.current)
      next.running = true; next.state.task!.phase = 'active'; next.state.task!.pendingConfirmation = undefined; next.runs![0].status = 'running'; update(next)
    },
    stop:async (id, expectedRunId) => {
      record('stop', { id, expectedRunId })
      const next = structuredClone(current.current); next.running = false; next.runs![0].status = 'cancelled'; next.state.task!.phase = 'paused'; update(next)
    },
    revoke:async (id, expected) => {
      record('revoke', { id, expected })
      const next = structuredClone(current.current); next.state.task!.pendingConfirmation = undefined; next.state.task!.phase = 'paused'; update(next)
    },
    refresh:async () => { setSyncing(false) },
  })
  return <main className="appShell" style={{ display:'block', padding:24 }}>
    <h1>宿主交互验收夹具</h1><p>只测试 UI；不调用模型，不修改会话或项目。打开 PageCraft 后，使用右下方夹具按钮注入状态。</p>
    <SlotOutlet runtime={runtime} name="conversation.input.left" sessionId="qa-host-only" owner={{}} />
    <div style={{ position:'fixed', bottom:12, right:12, zIndex:12000, background:'#fff', border:'1px solid #aaa', padding:12, borderRadius:8, maxWidth:'min(510px, 90vw)' }}>
      <strong>QA 夹具控制 · 非真实任务</strong><div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
        <button onClick={() => inject('confirm')}>注入确认</button><button onClick={() => inject('fallback')}>注入异常</button><button onClick={() => inject('ask_user')}>注入补充</button>
        <button onClick={() => inject('chat')}>普通回复</button><button onClick={() => inject('running')}>模拟运行</button><button onClick={() => setSyncing(true)}>模拟断线</button>
        <button onClick={() => { window.setTimeout(() => inject('confirm'), 3000) }}>3 秒后确认</button>
      </div><output aria-label="QA 操作记录" style={{ display:'block', whiteSpace:'pre-wrap', maxHeight:100, overflow:'auto', fontSize:11 }}>{log.length ? log.join('\n') : '尚未提交任何操作'}</output>
    </div>
    <TaskInteractionHost interaction={view} actions={actions} onRefresh={async () => { setSyncing(false) }} />
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
