import type { SessionDetail, StreamEvent } from './api'
import { partialOutputText, sessionTimeline, type TimelineItem } from './sessionTimeline'
import type { TaskState } from './api'

const taskLabels: Record<TaskState['phase'], string> = { active: '本轮运行结束', awaiting_input: '等待补充信息', awaiting_confirmation: '等待确认', paused: '任务已暂停', completed: '任务完成', cancelled: '任务已取消' }

type RequestState = { promptId: string; raw: string; assistantId?: string; segment: number; terminal: boolean }
type SessionView = {
  timeline: TimelineItem[]
  activities: { id:string; sessionId:string; content:string }[]
  status: string
  deltaCount: number
  aborting: boolean
}
type SessionState = SessionView & { requests: Map<string, RequestState>; serverRunning: boolean; revision: number; readSequence: number }
export type SnapshotToken = { revision: number; sequence: number }

/** Transport buffers and execution state are owned by sessions, never by the selected view. */
export class SessionRuntime {
  private readonly sessions = new Map<string, SessionState>()
  private state(id: string): SessionState {
    let state = this.sessions.get(id)
    if (!state) {
      state = { timeline:[], activities:[], status:'就绪', deltaCount:0, aborting:false, requests:new Map(), serverRunning:false, revision:0, readSequence:0 }
      this.sessions.set(id, state)
    }
    return state
  }
  view(id: string): SessionView { return this.state(id) }
  hasStreams(id: string): boolean { return this.state(id).requests.size > 0 }
  isRunning(id: string): boolean {
    const s = this.state(id)
    return s.serverRunning || [...s.requests.values()].some(r => !r.terminal)
  }
  begin(id: string, requestId: string, prompt: string): void {
    const s = this.state(id), promptId = `${requestId}:prompt`
    s.requests.set(requestId, { promptId, raw:'', segment:0, terminal:false })
    s.timeline = [...s.timeline, { id:promptId, role:'user', content:prompt }]
    s.activities = []; s.status = '模型思考中'; s.deltaCount = 0; s.revision++
  }
  end(id: string, requestId: string, recover = false): void {
    const s = this.state(id)
    s.requests.delete(requestId)
    if (!s.requests.size) { s.serverRunning = recover; s.aborting = false; s.activities = [] }
    s.status = this.isRunning(id) ? '正在执行' : '就绪'
    s.revision++
  }
  aborting(id: string, value: boolean): void {
    const s = this.state(id); s.aborting = value; s.status = value ? '正在中断' : s.status; s.revision++
  }
  error(id: string, message: string): void {
    const s = this.state(id); s.status = message; s.revision++
  }
  snapshotToken(id: string): SnapshotToken {
    const s = this.state(id)
    return { revision:s.revision, sequence:++s.readSequence }
  }
  snapshot(id: string, token: SnapshotToken, detail: SessionDetail): boolean {
    const s = this.state(id)
    if (detail.id !== id || token.revision !== s.revision || token.sequence !== s.readSequence) return false
    s.serverRunning = detail.running
    // Live buffers remain complete even when switching away and back. Don't mix a
    // lagging disk snapshot into a still-connected stream's optimistic messages.
    if (!s.requests.size) {
      s.timeline = sessionTimeline(detail.messages, detail.runs)
      s.activities = []
      s.deltaCount = 0
      s.aborting = false
      s.status = detail.running ? '正在执行（恢复同步）' : detail.state.task ? taskLabels[detail.state.task.phase] : '就绪'
    }
    return true
  }
  event(id: string, requestId: string, event: StreamEvent, activity?: string): void {
    const s = this.state(id), r = s.requests.get(requestId)
    if (!r || (event.type === 'run' && event.run.sessionId !== id)) return
    s.revision++
    if (event.type === 'run') {
      const run = event.run
      const promptId = run.userMessageId || r.promptId
      s.timeline = s.timeline.map(item => item.id === r.promptId ? {...item,id:promptId} : item)
      r.promptId = promptId
      r.terminal = !['queued','running'].includes(run.status)
      if (r.terminal) s.serverRunning = false
      if (run.status === 'running' || r.terminal) s.aborting = false
      const statusItem = sessionTimeline([], [run]).find(item=>item.id===`${run.id}:status`)!
      this.put(s, statusItem)
      return
    }
    if (event.type === 'start') { r.raw=''; r.assistantId=undefined; s.aborting=false; s.deltaCount=0; s.status='模型思考中'; return }
    if (event.type === 'retry') {
      if (r.assistantId) s.timeline = s.timeline.filter(row => row.id !== r.assistantId)
      r.raw = ''; r.assistantId = undefined; s.deltaCount = 0
      s.status = `${event.reason}，正在重试 ${event.attempt}/${event.maxAttempts}`
      return
    }
    if (event.type === 'delta') {
      r.raw += event.text
      const content = partialOutputText(r.raw)
      if (content) {
        r.assistantId ??= `${requestId}:assistant:${r.segment++}`
        this.put(s, {id:r.assistantId, role:'assistant',content})
      }
      s.deltaCount++; s.status='Agent 正在生成'; return
    }
    if (event.type === 'output') {
      this.put(s, {id:r.assistantId ?? `${requestId}:assistant:${r.segment++}`, role:'assistant',content:event.message})
      r.raw=''; r.assistantId=undefined; return
    }
    if (event.type === 'tool_call') { r.raw=''; r.assistantId=undefined }
    if (event.type === 'tool_call' || event.type === 'tool_result') {
      if (activity) s.activities = [...s.activities, {id:`${requestId}:activity:${s.revision}`,sessionId:id,content:activity}]
      s.status='正在执行'; return
    }
    if (event.type === 'error') {
      this.put(s,{id:`${requestId}:error:${s.revision}`,role:'error',content:event.message}); s.status='出错'; return
    }
    if (event.type === 'aborted') { r.terminal=true; s.status='操作已取消'; return }
    if (event.type === 'done') { r.terminal=true; s.serverRunning=false; s.aborting=false; s.activities=[]; s.status=this.isRunning(id)?'下一条请求排队中':'就绪' }
  }
  private put(state: SessionState, item: TimelineItem) {
    state.timeline = state.timeline.some(row=>row.id===item.id)
      ? state.timeline.map(row=>row.id===item.id ? item : row)
      : [...state.timeline,item]
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort',done); resolve() }
    const timer = setTimeout(done,ms)
    signal.addEventListener('abort',done,{once:true})
  })
}

/** One snapshot request at a time; cancellation suppresses results, errors back off. */
export async function recoverSession<T extends {running:boolean}>(options: {
  signal: AbortSignal; load(): Promise<T>; apply(value:T): void; onError(error:unknown): void
  wait?: (ms:number,signal:AbortSignal)=>Promise<void>
}): Promise<void> {
  let failures=0
  while (!options.signal.aborted) {
    try {
      const result=await options.load()
      if(options.signal.aborted) return
      options.apply(result); failures=0
      if(!result.running) return
    } catch(error) {
      if(options.signal.aborted) return
      options.onError(error); failures++
    }
    await (options.wait ?? abortableDelay)(Math.min(1000 * 2 ** Math.min(failures,4),10000),options.signal)
  }
}
