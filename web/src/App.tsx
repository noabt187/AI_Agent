import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CheckCircle2,
  Eye,
  FolderOpen,
  Gauge,
  MessageSquare,
  MousePointer2,
  Plus,
  RefreshCcw,
  Send,
  Trash2,
  X,
} from 'lucide-react'
import {
  createSession,
  listSessions,
  listDirectories,
  loadSession,
  loadSessionMetrics,
  pickDirectory,
  streamPrompt,
  updateAllowedPaths,
  type Message,
  type DirectoryListing,
  type SessionMetrics,
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
type ViewMode = 'chat' | 'preview' | 'metrics'

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
    .map((message) => {
      const content = messageContent(message).trim()
      return {
        id: message.uuid,
        role: (message.role === 'user' ? 'user' : 'assistant') as TimelineItem['role'],
        content,
      }
    })
    .filter((item) => item.content.length > 0)
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value)
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function formatDuration(value: number): string {
  if (value <= 0) return '0 ms'
  if (value < 1000) return `${value} ms`
  return `${(value / 1000).toFixed(2)} s`
}

function parseToolArguments(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string')) as Record<string, string>
  } catch {
    return {}
  }
}

function summarizeLines(text: string, maxLines = 3): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return '无输出'
  const visible = lines.slice(0, maxLines).join('\n')
  return lines.length > maxLines ? `${visible}\n...` : visible
}

function formatToolCall(name: string, rawArguments: string): string {
  const args = parseToolArguments(rawArguments)
  const file = args.relativePath || args.dirPath || args.pattern || args.keyword || args.changedFiles

  if (name === 'readTextFile') return `读取文件：${args.relativePath || '未指定文件'}`
  if (name === 'listDirectory') return `查看目录：${args.dirPath || '.'}`
  if (name === 'searchFiles') return `搜索文件：${args.pattern || '未指定模式'}`
  if (name === 'searchContent') return `搜索内容：${args.keyword || '未指定关键词'}`
  if (name === 'writeFile') return `修改文件：${args.relativePath || '未指定文件'}`
  if (name === 'deleteFile') return `删除文件：${args.relativePath || '未指定文件'}`
  if (name === 'execCommand') return `运行命令：${args.command || '未指定命令'}`
  if (name === 'verifyCode') return `验证代码：${file || '本次修改'}`
  return `调用工具：${name}`
}

function formatToolResult(name: string, result: string): string {
  if (name === 'readTextFile') return '读取完成'
  if (name === 'listDirectory') return `目录读取完成：${result.split('\n').filter(Boolean).length} 项`
  if (name === 'searchFiles' || name === 'searchContent') {
    if (result.includes('没有找到')) return '搜索完成：没有匹配结果'
    return `搜索完成：${result.split('\n').filter(Boolean).length} 条结果`
  }
  if (name === 'writeFile' || name === 'deleteFile') return result
  if (name === 'execCommand') {
    const failed = result.includes('[exit code:')
    return `${failed ? '命令失败' : '命令完成'}：${summarizeLines(result, 2)}`
  }
  if (name === 'verifyCode') return summarizeLines(result, 5)
  return `${name} 完成`
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
  const [previewDraftUrl, setPreviewDraftUrl] = useState('http://localhost:4000')
  const [previewUrl, setPreviewUrl] = useState('')
  const [previewEditorOpen, setPreviewEditorOpen] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('chat')
  const [metrics, setMetrics] = useState<SessionMetrics | null>(null)
  const [metricsError, setMetricsError] = useState('')
  const [confirmEditorOpen, setConfirmEditorOpen] = useState(false)
  const [confirmDraft, setConfirmDraft] = useState('')
  const [annotateActive, setAnnotateActive] = useState(false)
  const [selectedElement, setSelectedElement] = useState<AnnotatedElement | null>(null)
  const [elementComment, setElementComment] = useState('')
  const [elementComments, setElementComments] = useState<ElementComment[]>([])
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('未连接')
  const [deltaCount, setDeltaCount] = useState(0)

  const pendingConfirm = session?.state.pendingConfirm
  const operationRoot = session?.state.allowedPaths[0] || ''

  function clearPendingConfirmLocal() {
    setSession((current) => current
      ? {
          ...current,
          state: {
            ...current.state,
            pendingConfirm: undefined,
          },
        }
      : current)
    setConfirmEditorOpen(false)
    setConfirmDraft('')
  }

  async function refreshSessions(preferredId?: string) {
    const nextSessions = await listSessions()
    setSessions(nextSessions)
    const nextId = preferredId || selectedSessionId || nextSessions[0]?.id || ''
    if (nextId) setSelectedSessionId(nextId)
  }

  async function refreshSession(sessionId = selectedSessionId, options: { updateTimeline?: boolean } = {}) {
    if (!sessionId) return
    const updateTimeline = options.updateTimeline ?? true
    const detail = await loadSession(sessionId)
    setSession(detail)
    if (updateTimeline) setTimeline(toTimeline(detail.messages))
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
    if (viewMode === 'metrics' && selectedSessionId) {
      void refreshMetrics(selectedSessionId)
    }
  }, [viewMode, selectedSessionId])

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

  async function refreshMetrics(sessionId = selectedSessionId) {
    if (!sessionId) return
    setMetricsError('')
    try {
      setMetrics(await loadSessionMetrics(sessionId))
    } catch (err) {
      setMetrics(null)
      setMetricsError(err instanceof Error ? err.message : String(err))
    }
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

  function openPreviewEditor() {
    setPreviewDraftUrl(previewUrl || previewDraftUrl || 'http://localhost:4000')
    setPreviewEditorOpen(true)
  }

  function savePreviewAddress() {
    handleOpenPreview()
    setPreviewEditorOpen(false)
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
      appendItem({ role: 'activity', content: formatToolCall(event.name, event.arguments) })
      return
    }
    if (event.type === 'tool_result') {
      appendItem({ role: 'activity', content: formatToolResult(event.name, event.result) })
      return
    }
    if (event.type === 'error') {
      appendItem({ role: 'error', content: event.message })
      setStatus('出错')
      return
    }
    if (event.type === 'done') {
      setTimeline((current) => current.filter((item) => item.role !== 'activity'))
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

  function handleConfirmAction() {
    clearPendingConfirmLocal()
    void sendPrompt('确认')
  }

  function handleCancelConfirm() {
    clearPendingConfirmLocal()
    void sendPrompt('取消')
  }

  function handleEditConfirm() {
    setConfirmEditorOpen(true)
    setConfirmDraft('')
  }

  function buildConfirmEditPrompt(feedback: string): string {
    if (!pendingConfirm) return feedback
    if (pendingConfirm.type === 'design') {
      return [
        '用户正在修改待确认的方案设计。',
        `原待确认方案是：\n${pendingConfirm.message}`,
        `用户修改意见是：\n${feedback}`,
        '请重新设计方案；如果修改意见改变了需求范围，请回到 requirement confirm，否则返回新的 design confirm。',
        '不要写代码。',
      ].join('\n\n')
    }

    return [
      '用户正在修改待确认的需求分析。',
      `原待确认需求是：\n${pendingConfirm.message}`,
      `用户修改意见是：\n${feedback}`,
      '请重新分析需求；如信息足够，返回新的 requirement confirm；如信息不足，ask_user。',
      '不要写代码。',
    ].join('\n\n')
  }

  function handleSubmitConfirmEdit() {
    if (!pendingConfirm || !confirmDraft.trim()) return
    const editPrompt = buildConfirmEditPrompt(confirmDraft.trim())
    clearPendingConfirmLocal()
    void sendPrompt(editPrompt)
  }

  const statusLabel = useMemo(() => {
    if (running) return deltaCount > 0 ? `生成中 · ${deltaCount}` : '运行中'
    return status
  }, [deltaCount, running, status])

  const workspaceSubtitle = useMemo(() => {
    if (viewMode === 'metrics') return '会话监控信息'
    if (viewMode === 'preview' && previewUrl) return previewUrl
    if (pendingConfirm) return `等待确认：${pendingConfirm.type === 'design' ? '方案' : '需求'}`
    return '本地 Agent 工作台'
  }, [pendingConfirm, previewUrl, viewMode])

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
            <p>{workspaceSubtitle}</p>
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
          </div>
        </header>

        <section className="workspaceControls">
          <div className="controlGroup pathControl">
            <button className="choosePathButton" onClick={() => void handlePickDirectory()}>
              <FolderOpen size={17} />
              选择操作目录
            </button>
          </div>

          <div className="controlGroup previewControl">
            <button className="openPreviewButton" onClick={openPreviewEditor}>
              <Eye size={17} />
              编辑预览地址
            </button>
          </div>

          <div className="controlGroup modeControl">
            <div className="modeStack">
              <button className={viewMode === 'chat' ? 'modeButton active' : 'modeButton'} onClick={() => setViewMode('chat')}>
                <MessageSquare size={17} />
                对话
              </button>
              <button
                className={viewMode === 'metrics' ? 'modeButton active' : 'modeButton'}
                disabled={!selectedSessionId}
                onClick={() => {
                  setViewMode('metrics')
                  void refreshMetrics()
                }}
              >
                <Gauge size={17} />
                监控
              </button>
            </div>
          </div>
        </section>

        {viewMode === 'metrics' ? (
          <div className="metricsView">
            {metricsError ? <div className="metricsError">{metricsError}</div> : null}
            {!metrics ? (
              <div className="emptyState">暂无监控信息</div>
            ) : (
              <>
                <section className="metricsSummary">
                  <article>
                    <span>调用次数</span>
                    <strong>{formatNumber(metrics.summary.callCount)}</strong>
                  </article>
                  <article>
                    <span>总 Token</span>
                    <strong>{formatNumber(metrics.summary.totalTokens)}</strong>
                  </article>
                  <article>
                    <span>Prompt Token</span>
                    <strong>{formatNumber(metrics.summary.totalPromptTokens)}</strong>
                  </article>
                  <article>
                    <span>Completion Token</span>
                    <strong>{formatNumber(metrics.summary.totalCompletionTokens)}</strong>
                  </article>
                  <article>
                    <span>平均延迟</span>
                    <strong>{formatDuration(metrics.summary.averageLatencyMs)}</strong>
                  </article>
                  <article>
                    <span>平均首 Token</span>
                    <strong>{formatDuration(metrics.summary.averageFirstTokenMs)}</strong>
                  </article>
                </section>

                <section className="metricsTableWrap">
                  <table className="metricsTable">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>时间</th>
                        <th>Prompt</th>
                        <th>Completion</th>
                        <th>总计</th>
                        <th>延迟</th>
                        <th>首 Token</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.calls.map((call, index) => (
                        <tr key={`${call.timestamp}-${index}`}>
                          <td>{index + 1}</td>
                          <td>{call.timestamp ? formatTime(call.timestamp) : '-'}</td>
                          <td>{formatNumber(call.promptTokens)}</td>
                          <td>{formatNumber(call.completionTokens)}</td>
                          <td>{formatNumber(call.promptTokens + call.completionTokens)}</td>
                          <td>{formatDuration(call.latencyMs)}</td>
                          <td>{formatDuration(call.firstTokenMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {metrics.calls.length === 0 ? <div className="emptyMetrics">当前会话还没有模型调用记录</div> : null}
                </section>
              </>
            )}
          </div>
        ) : viewMode === 'preview' ? (
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
            {confirmEditorOpen ? (
              <>
                <textarea
                  value={confirmDraft}
                  onChange={(event) => setConfirmDraft(event.target.value)}
                  placeholder={`输入你想调整的${pendingConfirm.type === 'design' ? '方案' : '需求'}内容`}
                  autoFocus
                />
                <div className="confirmActions">
                  <button className="primary" disabled={!confirmDraft.trim()} onClick={handleSubmitConfirmEdit}>
                    提交修改
                  </button>
                  <button className="secondary" onClick={() => {
                    setConfirmEditorOpen(false)
                    setConfirmDraft('')
                  }}>
                    返回
                  </button>
                </div>
              </>
            ) : (
              <div className="confirmActions">
                <button className="primary" onClick={handleConfirmAction}>
                  <CheckCircle2 size={18} />
                  确认
                </button>
                <button className="secondary" onClick={handleEditConfirm}>修改</button>
                <button className="secondary" onClick={handleCancelConfirm}>取消</button>
              </div>
            )}
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

      {previewEditorOpen ? (
        <div className="modalBackdrop">
          <section className="previewAddressModal" aria-label="编辑预览地址">
            <header>
              <div>
                <h3>编辑预览地址</h3>
                <p>输入正在运行的前端页面地址</p>
              </div>
              <button className="miniIconButton static" title="关闭" onClick={() => setPreviewEditorOpen(false)}>
                <X size={17} />
              </button>
            </header>
            <div className="previewAddressBody">
              <input
                className="urlInput large"
                value={previewDraftUrl}
                onChange={(event) => setPreviewDraftUrl(event.target.value)}
                placeholder="http://localhost:4000"
                autoFocus
              />
              <div className="dockActions">
                <button onClick={() => setPreviewEditorOpen(false)}>取消</button>
                <button disabled={!previewDraftUrl.trim()} onClick={savePreviewAddress}>
                  打开预览
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  )
}
