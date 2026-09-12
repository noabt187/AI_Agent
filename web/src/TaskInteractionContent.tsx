import { useState } from 'react'
import type { TaskInteraction } from './taskInteraction'
import type { TaskInteractionActions } from './useTaskInteractionActions'

type Draft = { text: string; editing: boolean; selection: string }
const emptyDraft: Draft = { text:'', editing:false, selection:'' }

/** One mounted form for both the chat entry point and the top-layer dialog. */
export function TaskInteractionContent({ interaction:v, actions:a }: { interaction: TaskInteraction | null; actions: TaskInteractionActions }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  if (!v) return null
  const draft = drafts[v.key] ?? emptyDraft
  const change = (patch: Partial<Draft>) => setDrafts(all => ({ ...all, [v.key]:{ ...(all[v.key] ?? emptyDraft), ...patch } }))
  const p = v.confirmation
  return <div className="host-task-content">
    {v.task && <p className="host-task-objective">{v.task.objective}</p>}
    {p ? <>
      <pre className="host-task-prose">{p.prompt || p.message}</pre>
      {!!p.selections?.length && <fieldset disabled={a.busy} className="host-task-options"><legend>选择方案</legend>
        {p.selections.map((selection, index) => <label key={index}><input type="radio" name="host-task-plan" value={selection} checked={draft.selection === selection} onChange={() => change({ selection })} />{selection}</label>)}
      </fieldset>}
      <p className="host-task-note">{p.allowWrite ? '确认后允许 Agent 按本方案修改当前操作目录。' : '本次确认仅继续分析，不授予写权限。'}</p>
      {draft.editing ? <form onSubmit={e => { e.preventDefault(); void a.revise(draft.text) }}>
        <label htmlFor="host-task-revision">调整意见</label>
        <textarea id="host-task-revision" value={draft.text} onChange={e => change({ text:e.target.value })} placeholder="说明需要调整的内容，本次不会确认执行" disabled={a.busy} />
        <div className="host-task-actions"><button type="submit" disabled={a.busy || !draft.text.trim()}>提交调整</button><button type="button" onClick={() => change({ editing:false })} disabled={a.busy}>返回方案</button></div>
      </form> : <div className="host-task-actions">
        <button className="host-task-primary" disabled={a.busy || (!!p.selections?.length && !draft.selection)} onClick={() => void a.confirm(draft.selection || undefined)}>{p.allowWrite ? '确认执行' : '继续分析'}</button>
        <button disabled={a.busy} onClick={() => change({ editing:true })}>调整方案</button>
        {!!p.selections?.length && <button disabled={a.busy} onClick={() => void a.compare()}>比较方案</button>}
        <button disabled={a.busy} onClick={() => void a.revoke()}>撤销本次确认</button>
      </div>}
    </> : <>
      {v.status === 'needs_attention' && <p className="host-task-note">没有可执行的正式确认记录。下面的回复不代表已授权，插件中的进度文字可能尚未更新。</p>}
      {v.reply && <pre className="host-task-prose">{v.reply}</pre>}
      {v.run?.error && <p role="alert">{v.run.error}</p>}
      {v.status === 'awaiting_input' && <ul>{v.task?.questions?.map((question, index) => <li key={index}>{question}</li>)}</ul>}
      {v.canFollowup && <form onSubmit={e => { e.preventDefault(); void a.followup(draft.text) }}>
        <label htmlFor="host-task-followup">{v.status === 'awaiting_input' ? '补充回答' : '补充说明'}</label>
        <textarea id="host-task-followup" value={draft.text} disabled={a.busy} onChange={e => change({ text:e.target.value })} placeholder="作为当前任务的新一轮说明提交，不继承旧写权限" />
        <div className="host-task-actions"><button disabled={a.busy || !draft.text.trim()} type="submit">提交说明</button>
          {v.status === 'needs_attention' && <button type="button" disabled={a.busy} onClick={() => void a.replan()}>请求重新给出方案</button>}
        </div>
      </form>}
      {v.status === 'turn_ended' && <p className="host-task-note">本轮执行已结束，不代表产物已生成或验收通过。{!v.canFollowup && '旧记录缺少可核实的任务归属，请回到主会话发送新请求。'}</p>}
      <div className="host-task-actions">
        {v.canResume && <button disabled={a.busy} onClick={() => void a.resume()}>继续原任务</button>}
        {v.canStop && <button disabled={a.busy} onClick={() => void a.stop()}>停止此运行</button>}
      </div>
    </>}
    {a.busy && <p role="status">正在提交并核实状态，请勿重复操作…</p>}
    {a.error && <p className="host-task-error" role="alert">{a.error}</p>}
  </div>
}
