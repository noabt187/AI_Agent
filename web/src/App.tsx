import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CheckCircle2,
  CircleStop,
  Eye,
  FolderOpen,
  Loader2,
  MessageSquare,
  MousePointer2,
  Plus,
  RefreshCcw,
  Send,
  Trash2,
  X,
} from 'lucide-react'
import {
  abortSession,
  createSession,
  listSessions,
  listDirectories,
  loadSession,
  pickDirectory,
  streamPrompt,
  updateAllowedPaths,
  type Message,
  type DirectoryListing,
  type SessionDetail,
  type SessionSummary,
  type StreamEvent,
} from './api'
import { buildAnnotationPrompt, type ElementComment } from './annotationPrompt'

type TimelineItem = {
  id: string
  role: 'user' | 'assistant' | 'activity' | 'error'
  content: string
}

type AnnotatedElement = Omit<ElementComment, 'id' | 'comment'>

function messageContent(message: Message): string {
  if (message.role !== 'assistant') return message.content
  const raw = message.content.trim()
  if (!raw.startsWith('{')) return message.content
  try {
    const parsed = JSON.parse(raw) as { message?: string; prompt?: string }
    return [parsed.message, parsed.prompt].filter(Boolean).join('\n\n') || message.content
  } catch {
    return message.content
  }
}

function toTimeline(messages: Message[]): TimelineItem[] {
  return messages
    .filter((message) => !message.isMeta && message.role !== 'system' && message.role !== 'tool')
    .map((message) => ({
      id: message.uuid,
      role: message.role === 'user' ? 'user' : 'assistant',
      content: messageContent(message),
    }))
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value)
}

function isWindowsClient(): boolean {
  return navigator.platform.toLowerCase().includes('win') || navigator.userAgent.includes('Windows')
}

export function App() {
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [session, setSession] = useState<SessionDetail | null>(null)
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  const [prompt, setPrompt] = useState('')
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false)
  const [directoryListing, setDirectoryListing] = useState<DirectoryListing | null>(null)
  const [directoryError, setDirectoryError] = useState('')
  const [previewDraftUrl, setPreviewDraftUrl] = useState('http://localhost:5173')
  const [previewUrl, setPreviewUrl] = useState('')
  const [viewMode, setViewMode] = useState<'chat' | 'preview'>('chat')
  const [annotateActive, setAnnotateActive] = useState(false)
  const [selectedElement, setSelectedElement] = useState<AnnotatedElement | null>(null)
  const [elementComment, setElementComment] = useState('')
  const [elementComments, setElementComments] = useState<ElementComment[]>([])
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('未连接')
  const [deltaCount, setDeltaCount] = useState(0)

  const pendingConfirm = session?.state.pendingConfirm
  const allowedPathsText = session?.state.allowedPaths.join('\n') || ''
  const operationRoot = session?.state.allowedPaths[0] || ''

  async function refreshSessions(preferredId?: string) {
    const nextSessions = await listSessions()
    setSessions(nextSessions)
    const nextId = preferredId || selectedSessionId || nextSessions[0]?.id || ''
    if (nextId) setSelectedSessionId(nextId)
  }

  async function refreshSession(sessionId = selectedSessionId) {
    if (!sessionId) return
    const detail = await loadSession(sessionId)
    setSession(detail)
    setTimeline(toTimeline(detail.messages))
    setRunning(detail.running)
    setStatus(detail.running ? '运行中' : '就绪')
  }

  useEffect(() => {
    void refreshSessions()
  }, [])

  useEffect(() => {
    if (selectedSessionId) void refreshSession(selectedSessionId)
  }, [selectedSessionId])

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (!event.data || event.data.type !== 'agent-element-selected') return
      setSelectedElement(event.data.payload as AnnotatedElement)
      setElementComment('')
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  function postAnnotatorState(active = annotateActive) {
    previewFrameRef.current?.contentWindow?.postMessage({ type: 'agent-annotator-set-active', active }, '*')
  }

  useEffect(() => {
    postAnnotatorState(annotateActive)
  }, [annotateActive, previewUrl])

  async function handleNewSession() {
    const sessionId = await createSession()
    await refreshSessions(sessionId)
    await refreshSession(sessionId)
  }

  function getDirectoryStartPath(): string | undefined {
    return operationRoot || undefined
  }

  async function openDirectoryPicker(startPath?: string, options: { roots?: boolean } = {}) {
    setDirectoryPickerOpen(true)
    setDirectoryError('')
    try {
      const listing = await listDirectories(options.roots ? undefined : startPath || getDirectoryStartPath(), options)
      setDirectoryListing(listing)
    } catch (err) {
      setDirectoryError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handlePickDirectory() {
    const startPath = getDirectoryStartPath()
    if (isWindowsClient()) {
      try {
        const result = await pickDirectory(startPath)
        if (result.path) {
          await chooseDirectory(result.path)
          return
        }
      } catch {}
    }
    await openDirectoryPicker(startPath)
  }

  function openDirectoryParent() {
    if (directoryListing?.parentPath) {
      void openDirectoryPicker(directoryListing.parentPath)
      return
    }
    if (directoryListing?.canListRoots && !directoryListing.isRootListing) {
      void openDirectoryPicker(undefined, { roots: true })
    }
  }

  async function chooseDirectory(path: string) {
    if (!selectedSessionId) return
    const detail = await updateAllowedPaths(selectedSessionId, [path])
    setSession(detail)
    setDirectoryPickerOpen(false)
    setDirectoryError('')
    setStatus('目录已更新')
  }

  function handleOpenPreview() {
    const nextUrl = previewDraftUrl.trim()
    if (!nextUrl) return
    setPreviewUrl(nextUrl)
    setViewMode('preview')
    setAnnotateActive(false)
    setSelectedElement(null)
  }

  function handleAddComment() {
    if (!selectedElement || !elementComment.trim()) return
    setElementComments((current) => [
      ...current,
      {
        ...selectedElement,
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        comment: elementComment.trim(),
      },
    ])
    setSelectedElement(null)
    setElementComment('')
  }

  function handleRemoveComment(id: string) {
    setElementComments((current) => current.filter((item) => item.id !== id))
  }

  async function handleSendComments() {
    if (elementComments.length === 0) return
    const commentPrompt = buildAnnotationPrompt(elementComments, operationRoot)
    setViewMode('chat')
    await sendPrompt(commentPrompt)
    setElementComments([])
    setAnnotateActive(false)
  }

  function appendItem(item: Omit<TimelineItem, 'id'>) {
    setTimeline((current) => [
      ...current,
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        ...item,
      },
    ])
  }

  function handleStreamEvent(event: StreamEvent) {
    if (event.type === 'start') {
      setStatus('Agent 已开始')
      return
    }
    if (event.type === 'delta') {
      setDeltaCount((count) => count + 1)
      setStatus('Agent 正在生成')
      return
    }
    if (event.type === 'output') {
      appendItem({ role: 'assistant', content: event.message })
      return
    }
    if (event.type === 'tool_call') {
      appendItem({ role: 'activity', content: `调用工具：${event.name}` })
      return
    }
    if (event.type === 'tool_result') {
      appendItem({ role: 'activity', content: `${event.name}: ${event.result}` })
      return
    }
    if (event.type === 'error') {
      appendItem({ role: 'error', content: event.message })
      setStatus('出错')
      return
    }
    if (event.type === 'done') {
      setStatus('就绪')
    }
  }

  async function sendPrompt(value: string) {
    const text = value.trim()
    if (!text || !selectedSessionId || running) return
    setPrompt('')
    setDeltaCount(0)
    setRunning(true)
    appendItem({ role: 'user', content: text })
    try {
      await streamPrompt(selectedSessionId, text, handleStreamEvent)
      await refreshSession(selectedSessionId)
      await refreshSessions(selectedSessionId)
    } catch (err) {
      appendItem({ role: 'error', content: err instanceof Error ? err.message : String(err) })
      setStatus('出错')
    } finally {
      setRunning(false)
    }
  }

  async function handleAbort() {
    if (!selectedSessionId) return
    await abortSession(selectedSessionId)
    setStatus('正在停止')
  }

  const statusLabel = useMemo(() => {
    if (running) return deltaCount > 0 ? `生成中 · ${deltaCount}` : '运行中'
    return status
  }, [deltaCount, running, status])

  return (
    <main className="appShell">
      <aside className="sidebar">
        <section className="brandBlock">
          <div>
            <h1>Agent Console</h1>
            <p>{statusLabel}</p>
          </div>
          <button className="iconButton" title="刷新" onClick={() => void refreshSession()}>
            <RefreshCcw size={18} />
          </button>
        </section>

        <section className="panel">
          <div className="panelHeader">
            <span>会话</span>
            <button className="iconButton" title="新建会话" onClick={() => void handleNewSession()}>
              <Plus size={18} />
            </button>
          </div>
          <div className="sessionList">
            {sessions.map((item) => (
              <button
                key={item.id}
                className={item.id === selectedSessionId ? 'sessionItem active' : 'sessionItem'}
                onClick={() => setSelectedSessionId(item.id)}
              >
                <span>{item.id}</span>
                <small>{formatTime(item.updatedAt)}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panelHeader">
            <span>操作目录</span>
          </div>
          <div className="selectedPathBox">
            <FolderOpen size={17} />
            <span>{allowedPathsText.trim() || '未选择操作目录'}</span>
          </div>
          <button className="choosePathButton" onClick={() => void handlePickDirectory()}>
            选择文件夹
          </button>
        </section>

        <section className="panel">
          <div className="panelHeader">
            <span>前端预览</span>
            <button className="iconButton" title="打开预览" onClick={handleOpenPreview}>
              <Eye size={18} />
            </button>
          </div>
          <input
            className="urlInput"
            value={previewDraftUrl}
            onChange={(event) => setPreviewDraftUrl(event.target.value)}
            placeholder="http://localhost:3000"
          />
          <div className="previewActions">
            <button className={viewMode === 'chat' ? 'modeButton active' : 'modeButton'} onClick={() => setViewMode('chat')}>
              对话
            </button>
            <button className={viewMode === 'preview' ? 'modeButton active' : 'modeButton'} onClick={() => setViewMode('preview')} disabled={!previewUrl}>
              预览
            </button>
          </div>
        </section>

        <section className="panel commentsPanel">
          <div className="panelHeader">
            <span>评论</span>
            <small>{elementComments.length}</small>
          </div>
          <div className="commentList">
            {elementComments.map((item) => (
              <article className="commentItem" key={item.id}>
                <div>
                  <strong>{item.tagName}</strong>
                  <span>{item.text || item.selector}</span>
                </div>
                <p>{item.comment}</p>
                <button className="miniIconButton" title="删除评论" onClick={() => handleRemoveComment(item.id)}>
                  <Trash2 size={15} />
                </button>
              </article>
            ))}
          </div>
          <button className="sendCommentsButton" disabled={elementComments.length === 0 || running} onClick={() => void handleSendComments()}>
            <MessageSquare size={17} />
            发送给 Agent
          </button>
        </section>
      </aside>

      <section className="workspace">
        <header className="workspaceHeader">
          <div>
            <h2>{selectedSessionId || '未选择会话'}</h2>
            <p>
              {viewMode === 'preview' && previewUrl
                ? previewUrl
                : pendingConfirm
                  ? `等待确认：${pendingConfirm.type === 'design' ? '方案' : '需求'}`
                  : '本地 Agent 工作台'}
            </p>
          </div>
          <div className="headerActions">
            {viewMode === 'preview' && previewUrl ? (
              <button
                className={annotateActive ? 'annotateButton active' : 'annotateButton'}
                title="评论模式"
                onClick={() => setAnnotateActive((active) => !active)}
              >
                <MousePointer2 size={18} />
                评论
              </button>
            ) : null}
            <button className="stopButton" title="停止当前任务" disabled={!running} onClick={() => void handleAbort()}>
              {running ? <Loader2 className="spin" size={18} /> : <CircleStop size={18} />}
              停止
            </button>
          </div>
        </header>

        {viewMode === 'preview' ? (
          <div className="previewStage">
            {previewUrl ? (
              <iframe
                ref={previewFrameRef}
                className="previewFrame"
                title="前端预览"
                src={`/api/preview?url=${encodeURIComponent(previewUrl)}`}
                onLoad={() => postAnnotatorState()}
              />
            ) : (
              <div className="emptyState">输入地址后打开预览</div>
            )}
          </div>
        ) : (
          <div className="timeline">
            {timeline.length === 0 ? (
              <div className="emptyState">新会话已准备好</div>
            ) : (
              timeline.map((item) => (
                <article key={item.id} className={`bubble ${item.role}`}>
                  <pre>{item.content}</pre>
                </article>
              ))
            )}
          </div>
        )}

        {selectedElement ? (
          <div className="elementCommentDock">
            <div className="selectedElementMeta">
              <strong>{selectedElement.tagName}</strong>
              <span>{selectedElement.text || selectedElement.selector}</span>
            </div>
            <textarea
              value={elementComment}
              onChange={(event) => setElementComment(event.target.value)}
              placeholder="写下你想改哪里"
            />
            <div className="dockActions">
              <button onClick={() => setSelectedElement(null)}>
                <X size={16} />
                关闭
              </button>
              <button disabled={!elementComment.trim()} onClick={handleAddComment}>
                <CheckCircle2 size={16} />
                添加评论
              </button>
            </div>
          </div>
        ) : null}

        {pendingConfirm ? (
          <div className="confirmBar">
            <button onClick={() => void sendPrompt('确认')}>
              <CheckCircle2 size={18} />
              确认
            </button>
            <button onClick={() => void sendPrompt('取消')}>取消</button>
          </div>
        ) : null}

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault()
            void sendPrompt(prompt)
          }}
        >
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="输入需求或问题"
            disabled={!selectedSessionId || running}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void sendPrompt(prompt)
              }
            }}
          />
          <button className="sendButton" title="发送" disabled={!prompt.trim() || !selectedSessionId || running}>
            <Send size={19} />
          </button>
        </form>
      </section>

      {directoryPickerOpen ? (
        <div className="modalBackdrop">
          <section className="directoryModal" aria-label="选择操作目录">
            <header>
              <div>
                <h3>选择操作目录</h3>
                <p>{directoryListing?.path || '正在读取文件夹'}</p>
              </div>
              <button className="miniIconButton static" title="关闭" onClick={() => setDirectoryPickerOpen(false)}>
                <X size={17} />
              </button>
            </header>

            {directoryError ? <div className="directoryError">{directoryError}</div> : null}

            <div className="directoryToolbar">
              <button
                disabled={!directoryListing?.parentPath && !(directoryListing?.canListRoots && !directoryListing.isRootListing)}
                onClick={openDirectoryParent}
              >
                {directoryListing?.parentPath ? '上一级' : '盘符列表'}
              </button>
              <button disabled={!directoryListing || directoryListing.isRootListing} onClick={() => directoryListing && void chooseDirectory(directoryListing.path)}>
                选择当前文件夹
              </button>
            </div>

            <div className="directoryList">
              {directoryListing?.entries.map((entry) => (
                <button key={entry.path} className="directoryItem" onClick={() => void openDirectoryPicker(entry.path)}>
                  <FolderOpen size={17} />
                  <span>{entry.name}</span>
                </button>
              ))}
              {directoryListing && directoryListing.entries.length === 0 ? (
                <div className="emptyDirectory">当前文件夹没有子文件夹</div>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </main>
  )
}
