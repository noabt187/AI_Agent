import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { TaskInteraction } from './taskInteraction'
import { TaskInteractionContent } from './TaskInteractionContent'
import type { TaskInteractionActions } from './useTaskInteractionActions'

export function TaskInteractionHost({ interaction:v, actions, onRefresh, openRequest = 0 }: {
  interaction: TaskInteraction | null; actions: TaskInteractionActions
  onRefresh(sessionId: string): Promise<void>; openRequest?: number
}) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const focusBefore = useRef<HTMLElement | null>(null)
  const seen = useRef(new Set<string>())
  const handledCompletion = useRef(actions.completed)
  const [hidden, setHidden] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const latest = useRef({ v, onRefresh }); latest.current = { v, onRefresh }
  function dismiss() { setOpen(false) }
  function show() { if (v) { seen.current.add(v.key); setOpen(true); setHidden(null) } }
  async function verify() {
    const owner = latest.current.v?.sessionId
    if (!owner) return
    setVerifying(true); setRefreshError('')
    try { await latest.current.onRefresh(owner) }
    catch { if (latest.current.v?.sessionId === owner) setRefreshError('连接中断，请稍后重新核实。') }
    finally { if (latest.current.v?.sessionId === owner) setVerifying(false) }
  }
  useEffect(() => {
    const visibility = () => { if (document.visibilityState === 'visible') void verify() }
    document.addEventListener('visibilitychange', visibility)
    return () => document.removeEventListener('visibilitychange', visibility)
  }, [])
  useEffect(() => { dismiss(); setVerifying(false); setRefreshError('') }, [v?.sessionId])
  useEffect(() => {
    if (v?.autoOpen && !verifying && !refreshError && document.visibilityState === 'visible' && !seen.current.has(v.key)) show()
  }, [v?.key, v?.autoOpen, verifying, refreshError])
  useEffect(() => { if (openRequest) show() }, [openRequest])
  useEffect(() => {
    if (actions.completed && actions.completed !== handledCompletion.current && actions.completed.sessionId === v?.sessionId
      && actions.completed.key !== v?.key && !actions.busy && v?.status !== 'syncing') {
      handledCompletion.current = actions.completed
      if (!v?.actionable) dismiss()
    }
  }, [actions.completed, actions.busy, v?.key])
  useEffect(() => {
    const node = dialog.current
    if (!node) return
    if (open && v && !node.open) {
      focusBefore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      node.showModal(); heading.current?.focus()
    } else if ((!open || !v) && node.open) {
      node.close()
      const previous = focusBefore.current
      if (previous?.isConnected && !node.contains(previous)) previous.focus()
      else trigger.current?.focus()
    }
  }, [open, !!v])
  // A replaced proposal must not inherit focus from the old authorization button.
  useEffect(() => { if (open && dialog.current?.open) heading.current?.focus() }, [v?.key])
  function onKey(event: KeyboardEvent) {
    // Isolate host keys from ordinary window-level plugin shortcuts.
    event.stopPropagation()
    if (event.key !== 'Escape') return
    event.preventDefault()
    if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) dismiss()
  }
  const persistent = !!v && (v.actionable || ['submitting', 'queued', 'running', 'stopping', 'syncing'].includes(v.status))
  return createPortal(<>
    {v && (hidden !== v.key || persistent) && <aside className="host-task-status" data-host-task-status aria-label="Agent 任务状态">
      <div><span className="host-task-eyebrow">{v.origin === 'plugin' ? '插件任务' : 'Agent 任务'} · {v.sessionId}</span><strong role="status">{v.label}</strong>
        {!!v.queued && <small>排队 {v.queued} 项</small>}</div>
      <button ref={trigger} onClick={show}>查看详情</button>
      {!persistent && <button aria-label="关闭任务状态" onClick={() => setHidden(v.key)}>×</button>}
    </aside>}
    <dialog ref={dialog} className="host-task-dialog" data-host-task-dialog aria-labelledby="host-task-title"
      onKeyDownCapture={onKey} onKeyUpCapture={e => e.stopPropagation()} onCancel={e => { e.preventDefault(); e.stopPropagation(); dismiss() }} onClose={dismiss}>
      <header><div><span className="host-task-eyebrow">Agent 任务 · {v?.sessionId}</span><h2 ref={heading} id="host-task-title" tabIndex={-1}>{v?.label ?? '任务状态'}</h2></div><button onClick={dismiss}>收起</button></header>
      <TaskInteractionContent interaction={v} actions={actions} />
      {(v?.status === 'syncing' || refreshError) && <div className="host-task-reconnect"><p>{refreshError || '正在核实服务端状态，暂不开放任务操作。'}</p><button disabled={verifying} onClick={() => void verify()}>重新核实</button></div>}
    </dialog>
  </>, document.body)
}
