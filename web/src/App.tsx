import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent as ReactChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  CircleStop,
  Check,
  Copy,
  Download,
  FileUp,
  FolderOpen,
  Gauge,
  GitPullRequest,
  List,
  MessageSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  PieChart,
  Plus,
  Power,
  PowerOff,
  RefreshCcw,
  Send,
  Settings2,
  Sun,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  TrendingUp,
  X,
} from 'lucide-react'
import {
  abortSession,
  clearPendingConfirm,
  createSession,
  deleteSession,
  deleteSkill,
  deleteMemoryItem,
  downloadSessionExport,
  listSessions,
  listSkills,
  listDirectories,
  loadRepositoryIdentity,
  loadSession,
  loadSessionMemory,
  loadSessionMetrics,
  revealMemoryItem,
  saveMemoryItem,
  consumePromptStream,
  updateMemorySettings,
  updateRepositoryConfig,
  updateAllowedPaths,
  updateSkillEnabled,
  updateSessionTitle,
  uploadSkill,
  type DirectoryListing,
  type ManagedSkill,
  type MemoryLayerId,
  type MemoryRecallMode,
  type MemoryType,
  type RepositoryConfig,
  type RepositoryIdentity,
  type SessionMemory,
  type SessionMetrics,
  type SessionDetail,
  type SessionSummary,
  type StreamEvent,
} from './api'
import { browserDraftStore } from './sessionDrafts'
import { SessionRuntime, recoverSession } from './sessionRuntime'
import { readSelectedSession, saveSelectedSession, selectExistingSession } from './sessionSelection'
import { SlotOutlet } from './plugins/SlotOutlet'
import type { BrowserPluginRuntime } from './plugins/runtime'
import type { PromptResult } from './plugins/types'

type TimelineItem = {
  id: string
  role: 'user' | 'assistant' | 'activity' | 'error'
  content: string
}

type ActivityItem = {
  id: string
  content: string
  sessionId: string
}

type PendingConfirm = {
  allowWrite: boolean
  message: string
}

type PlanOption = {
  key: string
  label: string
  value?: string
}

type ViewMode = 'chat' | 'metrics'
type MetricsViewMode = 'detail' | 'trend' | 'anomaly' | 'composition'
type ThemeMode = 'dark' | 'light'
type NegativeFeedbackDraft = {
  itemId: string
  content: string
  reasons: string[]
  detail: string
}
type SessionContextMenu = {
  sessionId: string
  x: number
  y: number
}
type SkillContextMenu = {
  skillId: string
  x: number
  y: number
}

function displaySessionTitle(session: Pick<SessionSummary, 'id' | 'title'>): string {
  return session.title?.trim() || session.id
}

function buildSessionExportFilename(session: Pick<SessionSummary, 'id' | 'title'>): string {
  const baseName = displaySessionTitle(session).replace(/[\\/:*?"<>|]+/g, '-').trim() || session.id
  return `${baseName}.json`
}

const negativeFeedbackReasons = ['不准确', '没有帮助', '没按要求做', '太啰嗦', '有风险']
const modelThinkingStatus = '模型思考中'
const composerMaxRows = 10
const allowWriteConfirmWarning = '⚠️ 确认此方案后，Agent 将获得文件写入权限（增/删/改），请仔细核对方案内容。'
const themeStorageKey = 'agent-console-theme'
const dismissedConfirmStoragePrefix = 'agent-console-dismissed-confirm:'

function getInitialThemeMode(): ThemeMode {
  if (typeof window === 'undefined') return 'dark'
  return window.localStorage.getItem(themeStorageKey) === 'light' ? 'light' : 'dark'
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

function percentOf(value: number, max: number): number {
  if (max <= 0) return 0
  return Math.max(3, Math.min(100, Math.round((value / max) * 100)))
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
  const file = args.filePath || args.dirPath || args.pattern || args.keyword || args.changedFiles

  if (name === 'readTextFile') return `读取文件：${args.filePath || '未指定文件'}`
  if (name === 'listDirectory') return `查看目录：${args.dirPath || '.'}`
  if (name === 'searchFiles') return `搜索文件：${args.pattern || '未指定模式'}`
  if (name === 'searchContent') return `搜索内容：${args.keyword || '未指定关键词'}`
  if (name === 'writeFile') return `修改文件：${args.filePath || '未指定文件'}`
  if (name === 'deleteFile') return `删除文件：${args.filePath || '未指定文件'}`
  if (name === 'execCommand') return `运行命令：${args.command || '未指定命令'}`
  if (name === 'verifyCode') return `验证代码：${file || '本次修改'}`
  return `调用工具：${name}`
}

function formatToolResult(name: string, result: string): string {
  if (name === 'readTextFile') return ''
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

function inferPendingConfirm(timeline: TimelineItem[], running: boolean): PendingConfirm | undefined {
  if (running) return undefined
  const latestVisible = [...timeline].reverse().find((item) => item.role === 'assistant' || item.role === 'user')
  if (latestVisible?.role !== 'assistant') return undefined
  const latestAssistant = latestVisible
  if (!latestAssistant) return undefined
  const content = latestAssistant.content.trim()
  if (!content || /任务完成|已完成|验证通过/.test(content)) return undefined

  const hasAllowWriteWarning = content.includes(allowWriteConfirmWarning)
    || /获得文件写入权限|增\/删\/改/.test(content)
  const waitingForChoice = /请选择|选择.*方案|选择.*选项|A\/B\/C|A\/B\/C\/D|A\/B\/C\/D\/E/.test(content)
  const waitingForConfirm = hasAllowWriteWarning
    || waitingForChoice
    || /确认后|等待确认|请确认|是否确认|确认以上|确认这个|需要确认以下|我需要确认/.test(content)
    || (/确认/.test(content) && /是否|吗|？|\?/.test(content))
  if (!waitingForConfirm) return undefined

  return {
    allowWrite: hasAllowWriteWarning || /方案|设计|任务顺序|待执行/.test(content),
    message: content,
  }
}

function pendingConfirmKey(sessionId: string, confirm: PendingConfirm): string {
  return [sessionId, confirm.allowWrite ? 'write' : 'read', confirm.message].join('\n')
}

function loadDismissedPendingConfirmKey(sessionId: string): string {
  if (typeof window === 'undefined' || !sessionId) return ''
  return window.localStorage.getItem(`${dismissedConfirmStoragePrefix}${sessionId}`) || ''
}

function saveDismissedPendingConfirmKey(sessionId: string, key: string): void {
  if (typeof window === 'undefined' || !sessionId) return
  window.localStorage.setItem(`${dismissedConfirmStoragePrefix}${sessionId}`, key)
}

function uniquePlanOptions(options: PlanOption[]): PlanOption[] {
  const seen = new Set<string>()
  return options.filter((option) => {
    if (seen.has(option.key)) return false
    seen.add(option.key)
    return true
  })
}

function detectPlanOptions(content: string): PlanOption[] {
  const matches: PlanOption[] = []
  const optionLetters = 'ABCDEFGH'

  for (const line of content.split('\n')) {
    const tableMatch = line.match(/^\s*\|\s*([A-Ha-h])\s*\|\s*(.+?)\s*\|/)
    if (!tableMatch) continue
    const key = tableMatch[1].toUpperCase()
    const value = tableMatch[2].replace(/^["“”]+|["“”]+$/g, '').trim()
    matches.push({
      key,
      label: key,
      value,
    })
  }

  const patterns = [
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(方案\s*([A-Ha-h]))(?:[：:、\s.)）-]|$)/g,
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(方案\s*([一二三四五六七八]))(?:[：:、\s.)）-]|$)/g,
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:([A-Ha-h])\s*[.)）]\s*)(?=\S)/g,
  ]

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const raw = match[2] || match[1]
      const normalized = raw.trim().toUpperCase()
      const key = optionLetters.includes(normalized) ? normalized : raw.trim()
      matches.push({
        key,
        label: optionLetters.includes(key) ? `方案 ${key}` : `方案${key}`,
      })
    }
  }

  return uniquePlanOptions(matches).slice(0, 8)
}

export interface AppProps {
  pluginRuntime: BrowserPluginRuntime
}

export function App({ pluginRuntime }: AppProps) {
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const selectedSessionIdRef = useRef('')
  const [sessionRuntime] = useState(() => new SessionRuntime())
  const recoveryControllers = useRef(new Map<string, AbortController>())
  const sessionListRequest = useRef(0)
  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  const skillContextMenuRef = useRef<HTMLDivElement | null>(null)
  const skillUploadInputRef = useRef<HTMLInputElement | null>(null)
  const skipSessionRenameBlurRef = useRef('')
  const submitPromptRef = useRef<(text: string, source: 'composer' | 'plugin', owner?: string) => Promise<PromptResult>>(
    async () => ({ ok: false, error: { message: 'AI Agent is still starting' } }),
  )
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [session, setSession] = useState<SessionDetail | null>(null)
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  const [activityItems, setActivityItems] = useState<ActivityItem[]>([])
  const [activityExpanded, setActivityExpanded] = useState(false)
  const [draftStore] = useState(browserDraftStore)
  const [, redrawDraft] = useState(0)
  const prompt = selectedSessionId ? draftStore.get(selectedSessionId).text : ''
  function setPrompt(text: string) {
    if (selectedSessionId) draftStore.set(selectedSessionId, text)
    redrawDraft(n => n + 1)
  }
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false)
  const [directoryListing, setDirectoryListing] = useState<DirectoryListing | null>(null)
  const [directoryError, setDirectoryError] = useState('')
  const [directoryPathInput, setDirectoryPathInput] = useState('')
  const [directoryBusy, setDirectoryBusy] = useState(false)
  const directoryRequest = useRef(0)
  const directoryOwner = useRef('')
  const [repositoryEditorOpen, setRepositoryEditorOpen] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('chat')
  const [metricsViewMode, setMetricsViewMode] = useState<MetricsViewMode>('detail')
  const [metrics, setMetrics] = useState<SessionMetrics | null>(null)
  const [metricsError, setMetricsError] = useState('')
  const [sessionMemory, setSessionMemory] = useState<SessionMemory | null>(null)
  const [memoryDraft, setMemoryDraft] = useState('')
  const [memoryError, setMemoryError] = useState('')
  const [memoryBusy, setMemoryBusy] = useState(false)
  const [repositoryDraft, setRepositoryDraft] = useState<RepositoryConfig>({})
  const [repositoryIdentity, setRepositoryIdentity] = useState<RepositoryIdentity | null>(null)
  const [repositoryIdentityBusy, setRepositoryIdentityBusy] = useState(false)
  const [repositoryBusy, setRepositoryBusy] = useState(false)
  const [repositoryError, setRepositoryError] = useState('')
  const [memoryManagerOpen, setMemoryManagerOpen] = useState(false)
  const [activeMemoryLayer, setActiveMemoryLayer] = useState<MemoryLayerId>('project')
  const [activeMemoryType, setActiveMemoryType] = useState<MemoryType>('project')
  const [confirmEditorOpen, setConfirmEditorOpen] = useState(false)
  const [confirmDraft, setConfirmDraft] = useState('')
  const [selectedPlanKey, setSelectedPlanKey] = useState('')
  const [running, setRunning] = useState(false)
  const [aborting, setAbortingState] = useState(false)
  const [status, setStatus] = useState('未连接')
  const [deltaCount, setDeltaCount] = useState(0)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [responseFeedback, setResponseFeedback] = useState<Record<string, 'up' | 'down'>>({})
  const [copiedResponseId, setCopiedResponseId] = useState('')
  const [negativeFeedbackDraft, setNegativeFeedbackDraft] = useState<NegativeFeedbackDraft | null>(null)
  const [sessionContextMenu, setSessionContextMenu] = useState<SessionContextMenu | null>(null)
  const [skills, setSkills] = useState<ManagedSkill[]>([])
  const [skillsBusy, setSkillsBusy] = useState(false)
  const [skillError, setSkillError] = useState('')
  const [skillManagerOpen, setSkillManagerOpen] = useState(false)
  const [skillContextMenu, setSkillContextMenu] = useState<SkillContextMenu | null>(null)
  const [editingSessionId, setEditingSessionId] = useState('')

  const [editingSessionTitle, setEditingSessionTitle] = useState('')
  const [dismissedPendingConfirmKey, setDismissedPendingConfirmKey] = useState('')
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialThemeMode)

  const selectedSessionSummary = useMemo(
    () => sessions.find((item) => item.id === selectedSessionId) ?? null,
    [selectedSessionId, sessions],
  )

  const rawPendingConfirm = session?.state.pendingConfirm
  const activePendingConfirmKey = selectedSessionId && rawPendingConfirm
    ? pendingConfirmKey(selectedSessionId, rawPendingConfirm)
    : ''
  const pendingConfirm = activePendingConfirmKey && activePendingConfirmKey === dismissedPendingConfirmKey
    ? undefined
    : rawPendingConfirm
  const pendingPlanOptions = useMemo(() => (
    pendingConfirm ? detectPlanOptions(pendingConfirm.message) : []
  ), [pendingConfirm])
  const hasPlanChoices = pendingPlanOptions.length > 1
  const selectedPlan = pendingPlanOptions.find((option) => option.key === selectedPlanKey)
  const operationRoot = session?.state.allowedPaths[0] || ''
  const repository = session?.state.repository || {}
  const enabledSkillCount = skills.filter((skill) => skill.enabled).length
  const sortedSkills = useMemo(
    () => [...skills].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)),
    [skills],
  )
  const selectedSkillMenuItem = skillContextMenu
    ? skills.find((skill) => skill.id === skillContextMenu.skillId) || null
    : null

  function clearPendingConfirmLocal(options: { dismiss?: boolean } = {}) {
    if (options.dismiss && selectedSessionId && pendingConfirm) {
      const key = pendingConfirmKey(selectedSessionId, pendingConfirm)
      saveDismissedPendingConfirmKey(selectedSessionId, key)
      setDismissedPendingConfirmKey(key)
    }
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
    setSelectedPlanKey('')
  }

  async function refreshSessions(preferredId?: string | null) {
    const request = ++sessionListRequest.current
    const owner = selectedSessionIdRef.current
    const nextSessions = await listSessions()
    if (request !== sessionListRequest.current) return
    setSessions(nextSessions)
    const preferred = owner !== selectedSessionIdRef.current
      ? selectedSessionIdRef.current
      : preferredId ?? (selectedSessionIdRef.current || readSelectedSession(window.sessionStorage))
    const nextId = selectExistingSession(nextSessions.map(item => item.id), preferred)
    setSelectedSessionId(nextId)
  }

  function syncRuntimeView(sessionId: string) {
    pluginRuntime.sessions.notifyRunningChanged(sessionId)
    if (selectedSessionIdRef.current !== sessionId) return
    const view = sessionRuntime.view(sessionId)
    setTimeline(view.timeline)
    setActivityItems(view.activities)
    setRunning(sessionRuntime.isRunning(sessionId))
    setAbortingState(view.aborting)
    setDeltaCount(view.deltaCount)
    setStatus(view.status)
  }

  async function refreshSession(sessionId = selectedSessionId) {
    if (!sessionId) return
    const token = sessionRuntime.snapshotToken(sessionId)
    const detail = await loadSession(sessionId)
    if (sessionId !== selectedSessionIdRef.current) return
    if (!sessionRuntime.snapshot(sessionId, token, detail)) return
    setSession(detail)
    syncRuntimeView(sessionId)
  }

  function stopRecovery(owner: string) {
    recoveryControllers.current.get(owner)?.abort()
    recoveryControllers.current.delete(owner)
  }

  function startRecovery(owner: string) {
    stopRecovery(owner)
    if (!owner || owner !== selectedSessionIdRef.current) return
    const controller = new AbortController()
    recoveryControllers.current.set(owner, controller)
    void recoverSession({
      signal: controller.signal,
      load: async () => {
        const token = sessionRuntime.snapshotToken(owner)
        const detail = await loadSession(owner, controller.signal)
        return { detail, token, running: detail.running && !sessionRuntime.hasStreams(owner) }
      },
      apply: ({ detail, token }) => {
        if (owner !== selectedSessionIdRef.current) return
        // Metadata is still needed when a live delta invalidates the timeline snapshot.
        setSession(detail)
        if (sessionRuntime.snapshot(owner, token, detail)) syncRuntimeView(owner)
      },
      onError: () => {
        sessionRuntime.error(owner, '连接中断，正在重试同步…')
        syncRuntimeView(owner)
      },
    }).finally(() => {
      if (recoveryControllers.current.get(owner) === controller) recoveryControllers.current.delete(owner)
    })
  }

  useEffect(() => {
    void refreshSessions().catch(() => setStatus('无法读取会话列表，请刷新重试'))
    void refreshSkills()
    return () => {
      selectedSessionIdRef.current = ''
      for (const controller of recoveryControllers.current.values()) controller.abort()
      recoveryControllers.current.clear()
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem(themeStorageKey, themeMode)
  }, [themeMode])

  useEffect(() => {
    setSelectedPlanKey('')
  }, [activePendingConfirmKey])

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId
    closeDirectoryPicker()
    setSession(null)
    if (selectedSessionId) {
      saveSelectedSession(selectedSessionId, window.sessionStorage)
      syncRuntimeView(selectedSessionId)
      startRecovery(selectedSessionId)
    } else {
      setTimeline([]); setActivityItems([]); setRunning(false); setAbortingState(false); setStatus('就绪')
    }
    setDismissedPendingConfirmKey(loadDismissedPendingConfirmKey(selectedSessionId))
    setActivityExpanded(false)
    setRepositoryError('')
    return () => stopRecovery(selectedSessionId)
  }, [selectedSessionId])

  useEffect(() => {
    if (!selectedSessionId) return
    return pluginRuntime.sessions.bind(selectedSessionId, {
      getRunning: () => sessionRuntime.isRunning(selectedSessionId),
      prompt: text => submitPromptRef.current(text, 'plugin', selectedSessionId),
    })
  }, [pluginRuntime, selectedSessionId])

  useEffect(() => {
    if (selectedSessionId) pluginRuntime.sessions.notifyRunningChanged(selectedSessionId)
  }, [pluginRuntime, running, selectedSessionId])

  useEffect(() => {
    setRepositoryDraft(session?.state.repository || {})
  }, [session?.id, session?.state.repository])

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (
        target instanceof Node
        && (contextMenuRef.current?.contains(target) || skillContextMenuRef.current?.contains(target))
      ) return
      setSessionContextMenu(null)
      setSkillContextMenu(null)
    }

    window.addEventListener('pointerdown', handlePointerDown)
    return () => window.removeEventListener('pointerdown', handlePointerDown)
  }, [])

  useEffect(() => {
    if (viewMode !== 'chat') return
    window.requestAnimationFrame(() => {
      const timelineEl = timelineRef.current
      if (!timelineEl) return
      timelineEl.scrollTop = timelineEl.scrollHeight
    })
  }, [selectedSessionId, viewMode, timeline.length, activityItems.length])

  useLayoutEffect(() => {
    const textarea = promptTextareaRef.current
    if (!textarea) return

    textarea.style.height = 'auto'
    const styles = window.getComputedStyle(textarea)
    const lineHeight = Number.parseFloat(styles.lineHeight)
    const fontSize = Number.parseFloat(styles.fontSize) || 16
    const resolvedLineHeight = Number.isFinite(lineHeight) ? lineHeight : fontSize * 1.45
    const padding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom)
    const border = Number.parseFloat(styles.borderTopWidth) + Number.parseFloat(styles.borderBottomWidth)
    const maxHeight = Math.ceil(resolvedLineHeight * composerMaxRows + padding + border)
    const scrollHeight = textarea.scrollHeight + border
    const nextHeight = Math.min(scrollHeight, maxHeight)

    textarea.style.height = `${nextHeight}px`
    textarea.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [prompt])

  useEffect(() => {
    if (selectedSessionId) void refreshMemory(selectedSessionId)
  }, [selectedSessionId])

  useEffect(() => {
    if (viewMode === 'metrics' && selectedSessionId) {
      void refreshMetrics(selectedSessionId)
    }
  }, [viewMode, selectedSessionId])

  async function handleNewSession() {
    const sessionId = await createSession()
    await refreshSessions(sessionId)
    await refreshSession(sessionId)
  }

  async function handleDeleteSession(sessionId: string) {
    const currentIndex = sessions.findIndex((item) => item.id === sessionId)
    const fallbackSessionId = sessions.find((item) => item.id !== sessionId)?.id
      || (currentIndex >= 0 ? sessions[currentIndex + 1]?.id || sessions[currentIndex - 1]?.id || '' : '')

    setSessionContextMenu(null)
    cancelSessionRename()

    try {
      await deleteSession(sessionId)
      const nextSelectedId = selectedSessionId === sessionId ? fallbackSessionId : selectedSessionId
      if (selectedSessionId === sessionId) {
        setSelectedSessionId(nextSelectedId)
        setSession(null)
        setTimeline([])
        setActivityItems([])
        setMetrics(null)
      }
      await refreshSessions(nextSelectedId)
      if (nextSelectedId) {
        await refreshSession(nextSelectedId)
      } else {
        setSession(null)
        setSelectedSessionId('')
      }
      setStatus('会话已删除')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : '删除会话失败')
    }
  }

  async function handleDownloadSession(sessionId: string) {
    const current = sessions.find((item) => item.id === sessionId) || { id: sessionId }
    setSessionContextMenu(null)

    try {
      const { blob, fileName } = await downloadSessionExport(sessionId)
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = fileName || buildSessionExportFilename(current)
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
      setStatus('会话已下载')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : '下载会话失败')
    }
  }

  function openSessionRename(sessionId: string) {
    const current = sessions.find((item) => item.id === sessionId)
    setSessionContextMenu(null)
    setEditingSessionId(sessionId)
    setEditingSessionTitle(current?.title?.trim() || '')
  }

  function cancelSessionRename() {
    setEditingSessionId('')
    setEditingSessionTitle('')
  }

  async function submitSessionRename(sessionId: string) {
    const nextTitle = editingSessionTitle.trim()
    const current = sessions.find((item) => item.id === sessionId)
    const currentTitle = current?.title?.trim() || ''
    if (nextTitle === currentTitle) {
      cancelSessionRename()
      return
    }

    try {
      const detail = await updateSessionTitle(sessionId, nextTitle)
      setSession(detail)
      await refreshSessions(sessionId)
      setStatus(nextTitle ? '会话名称已更新' : '已恢复默认会话名称')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : '更新会话名称失败')
    } finally {
      cancelSessionRename()
    }
  }

  function handleSessionTitleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>, sessionId: string) {
    if (event.key === 'Enter') {
      event.preventDefault()
      skipSessionRenameBlurRef.current = sessionId
      void submitSessionRename(sessionId)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      skipSessionRenameBlurRef.current = sessionId
      cancelSessionRename()
    }
  }

  function handleSessionContextMenu(event: ReactMouseEvent<HTMLButtonElement>, sessionId: string) {
    event.preventDefault()
    setSessionContextMenu({
      sessionId,
      x: event.clientX,
      y: event.clientY,
    })
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

  async function refreshMemory(sessionId = selectedSessionId) {
    if (!sessionId) return
    setMemoryError('')
    try {
      const memory = await loadSessionMemory(sessionId)
      if (sessionId !== selectedSessionIdRef.current) return
      setSessionMemory(memory)
    } catch (err) {
      if (sessionId !== selectedSessionIdRef.current) return
      setSessionMemory(null)
      setMemoryError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleMemoryModeChange(mode: MemoryRecallMode) {
    if (!selectedSessionId || memoryBusy) return
    setMemoryBusy(true)
    setMemoryError('')
    try {
      const detail = await updateMemorySettings(selectedSessionId, mode)
      setSession(detail)
      await refreshMemory(selectedSessionId)
    } catch (err) {
      setMemoryError(err instanceof Error ? err.message : String(err))
    } finally {
      setMemoryBusy(false)
    }
  }

  async function handleSaveRepositoryConfig() {
    if (!selectedSessionId || repositoryBusy) return
    setRepositoryBusy(true)
    setRepositoryError('')
    try {
      const detail = await updateRepositoryConfig(selectedSessionId, {
        ...repositoryDraft,
        githubLogin: repositoryIdentity?.githubLogin ?? repositoryDraft.githubLogin,
        gitUserName: repositoryIdentity?.gitUserName ?? repositoryDraft.gitUserName,
        gitUserEmail: repositoryIdentity?.gitUserEmail ?? repositoryDraft.gitUserEmail,
      })
      setSession(detail)
      setRepositoryDraft(detail.state.repository || {})
      setRepositoryEditorOpen(false)
      setStatus('仓库配置已更新')
    } catch (err) {
      setRepositoryError(err instanceof Error ? err.message : String(err))
    } finally {
      setRepositoryBusy(false)
    }
  }

  function updateRepositoryDraft(key: keyof RepositoryConfig, value: string) {
    setRepositoryDraft((current) => ({ ...current, [key]: value }))
  }

  async function refreshRepositoryIdentity(sessionId = selectedSessionId) {
    if (!sessionId) {
      setRepositoryIdentity(null)
      return
    }
    setRepositoryIdentityBusy(true)
    try {
      setRepositoryIdentity(await loadRepositoryIdentity(sessionId))
    } catch {
      setRepositoryIdentity(null)
    } finally {
      setRepositoryIdentityBusy(false)
    }
  }

  function openRepositoryEditor() {
    setRepositoryDraft(session?.state.repository || {})
    setRepositoryError('')
    setRepositoryEditorOpen(true)
    void refreshRepositoryIdentity()
  }

  async function handleSaveMemoryItem() {
    const content = memoryDraft.trim()
    if (!selectedSessionId || !content || memoryBusy) return
    setMemoryBusy(true)
    setMemoryError('')
    try {
      const result = await saveMemoryItem(selectedSessionId, {
        layer: activeMemoryLayer,
        type: activeMemoryType,
        description: content,
        body: content,
      })
      setSessionMemory(result.memoryState)
      setMemoryDraft('')
    } catch (err) {
      setMemoryError(err instanceof Error ? err.message : String(err))
    } finally {
      setMemoryBusy(false)
    }
  }

  async function handleDeleteMemoryItem(name: string) {
    if (!selectedSessionId || memoryBusy) return
    setMemoryBusy(true)
    setMemoryError('')
    try {
      const result = await deleteMemoryItem(selectedSessionId, name)
      setSessionMemory(result.memoryState)
    } catch (err) {
      setMemoryError(err instanceof Error ? err.message : String(err))
    } finally {
      setMemoryBusy(false)
    }
  }

  async function handleRevealMemoryItem(layer: MemoryLayerId, name: string) {
    if (!selectedSessionId || memoryBusy) return
    setMemoryBusy(true)
    setMemoryError('')
    try {
      await revealMemoryItem(selectedSessionId, layer, name)
      setStatus('已打开记忆文件位置')
    } catch (err) {
      setMemoryError(err instanceof Error ? err.message : String(err))
    } finally {
      setMemoryBusy(false)
    }
  }

  async function refreshSkills() {
    setSkillError('')
    try {
      setSkills(await listSkills())
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : String(err))
    }
  }

  function handleUploadSkillClick() {
    skillUploadInputRef.current?.click()
  }

  async function handleSkillFileSelected(event: ReactChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file || skillsBusy) return
    if (!file.name.toLowerCase().endsWith('.md')) {
      setSkillError('Skill 文件必须是 .md')
      return
    }

    setSkillsBusy(true)
    setSkillError('')
    try {
      await uploadSkill(file.name, await file.text())
      await refreshSkills()
      setStatus(`Skill 已上传：${file.name}`)
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : String(err))
    } finally {
      setSkillsBusy(false)
    }
  }

  async function handleSkillEnabled(skill: ManagedSkill, enabled: boolean) {
    if (skillsBusy || skill.enabled === enabled) return
    setSkillsBusy(true)
    setSkillError('')
    try {
      const result = await updateSkillEnabled(skill.id, enabled)
      setSkills((current) => current.map((item) => item.id === result.skill.id ? result.skill : item))
      setStatus(`${enabled ? '已启用' : '已卸载'} Skill：${skill.name}`)
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : String(err))
    } finally {
      setSkillsBusy(false)
    }
  }

  async function handleDeleteSkill(skill: ManagedSkill) {
    if (skillsBusy || skill.source !== 'custom') return
    const confirmed = window.confirm(`删除上传的 Skill「${skill.name}」？`)
    if (!confirmed) return

    setSkillsBusy(true)
    setSkillError('')
    setSkillContextMenu(null)
    try {
      await deleteSkill(skill.id)
      setSkills((current) => current.filter((item) => item.id !== skill.id))
      setStatus(`Skill 已删除：${skill.name}`)
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : String(err))
    } finally {
      setSkillsBusy(false)
    }
  }

  function handleSkillContextMenu(event: ReactMouseEvent<HTMLElement>, skillId: string) {
    event.preventDefault()
    setSkillContextMenu({
      skillId,
      x: event.clientX,
      y: event.clientY,
    })
  }

  function getDirectoryStartPath(): string | undefined {
    return operationRoot || undefined
  }

  async function openDirectoryPicker(startPath?: string, options: { roots?: boolean; home?: boolean } = {}) {
    const owner = selectedSessionIdRef.current
    if (!owner) return
    directoryOwner.current = owner
    const request = ++directoryRequest.current
    setDirectoryPickerOpen(true)
    setDirectoryError('')
    setDirectoryBusy(true)
    try {
      const listing = await listDirectories(options.roots || options.home ? undefined : startPath || getDirectoryStartPath(), options)
      if (request !== directoryRequest.current || selectedSessionIdRef.current !== owner) return
      setDirectoryListing(listing)
      setDirectoryPathInput(listing.isRootListing ? '' : listing.path)
    } catch (err) {
      if (request !== directoryRequest.current || selectedSessionIdRef.current !== owner) return
      setDirectoryError(err instanceof Error ? err.message : String(err))
    } finally {
      if (request === directoryRequest.current) setDirectoryBusy(false)
    }
  }

  function closeDirectoryPicker() {
    directoryRequest.current += 1
    directoryOwner.current = ''
    setDirectoryPickerOpen(false)
    setDirectoryBusy(false)
    setDirectoryListing(null)
    setDirectoryError('')
  }

  async function handlePickDirectory() {
    await openDirectoryPicker(getDirectoryStartPath())
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
    const owner = directoryOwner.current
    if (!owner || owner !== selectedSessionIdRef.current || directoryBusy || directoryError) return
    const request = ++directoryRequest.current
    setDirectoryBusy(true)
    try {
      const detail = await updateAllowedPaths(owner, [path])
      if (request !== directoryRequest.current || owner !== selectedSessionIdRef.current) return
      setSession(detail)
      closeDirectoryPicker()
      setStatus('目录已更新')
      await refreshMemory(owner)
    } catch (err) {
      if (request === directoryRequest.current) setDirectoryError(err instanceof Error ? err.message : String(err))
    } finally {
      if (request === directoryRequest.current) setDirectoryBusy(false)
    }
  }


  async function handleCopyResponse(itemId: string, content: string) {
    try {
      await navigator.clipboard.writeText(content)
      setCopiedResponseId(itemId)
      setStatus('回复已复制')
      window.setTimeout(() => {
        setCopiedResponseId((current) => (current === itemId ? '' : current))
      }, 1800)
    } catch {
      setStatus('复制失败')
    }
  }

  function handleFeedback(itemId: string, value: 'up' | 'down') {
    setResponseFeedback((current) => {
      const next = { ...current }
      if (next[itemId] === value) {
        delete next[itemId]
      } else {
        next[itemId] = value
      }
      return next
    })
  }

  function handleNegativeFeedback(itemId: string, content: string) {
    if (responseFeedback[itemId] === 'down') {
      setResponseFeedback((current) => {
        const next = { ...current }
        delete next[itemId]
        return next
      })
      setNegativeFeedbackDraft((current) => (current?.itemId === itemId ? null : current))
      return
    }

    setResponseFeedback((current) => ({ ...current, [itemId]: 'down' }))
    setNegativeFeedbackDraft({
      itemId,
      content,
      reasons: [],
      detail: '',
    })
  }

  function toggleNegativeReason(reason: string) {
    setNegativeFeedbackDraft((current) => {
      if (!current) return current
      const exists = current.reasons.includes(reason)
      return {
        ...current,
        reasons: exists ? current.reasons.filter((item) => item !== reason) : [...current.reasons, reason],
      }
    })
  }

  function closeNegativeFeedback() {
    setNegativeFeedbackDraft(null)
  }

  function submitNegativeFeedback() {
    if (!negativeFeedbackDraft) return
    setStatus('反馈已记录')
    setNegativeFeedbackDraft(null)
  }

  function findPreviousUserPrompt(itemIndex: number): string {
    for (let index = itemIndex - 1; index >= 0; index -= 1) {
      if (timeline[index]?.role === 'user') return timeline[index].content
    }
    return ''
  }

  function handleRegenerate(itemIndex: number) {
    const previousPrompt = findPreviousUserPrompt(itemIndex)
    if (!previousPrompt) {
      setStatus('未找到上一条问题')
      return
    }
    void sendPrompt(previousPrompt)
  }

  function handleStreamEvent(sessionId: string, requestId: string, event: StreamEvent) {
    const activity = event.type === 'tool_call'
      ? formatToolCall(event.name, event.arguments)
      : event.type === 'tool_result' ? formatToolResult(event.name, event.result) : undefined
    sessionRuntime.event(sessionId, requestId, event, activity || undefined)
    syncRuntimeView(sessionId)
  }

  async function submitPrompt(value: string, source: 'composer' | 'plugin', owner?: string): Promise<PromptResult> {
    const text = value.trim()
    const sessionId = owner || selectedSessionIdRef.current
    if (!text) return { ok: false, error: { message: 'Prompt is empty' } }
    if (!sessionId) return { ok: false, error: { message: 'No active session' } }
    if (source === 'composer' && session?.id !== sessionId) {
      return { ok: false, error: { message: '会话仍在同步，请稍后重试' } }
    }
    if (source === 'composer' && sessionRuntime.isRunning(sessionId)) {
      return { ok: false, error: { message: 'The active session is already running' } }
    }
    const draftRevision = source === 'composer' ? draftStore.get(sessionId).revision : undefined
    return new Promise<PromptResult>((resolve) => {
      void consumeSubmittedPrompt(sessionId, text, result => {
        if (result.ok && draftRevision !== undefined) {
          draftStore.accept(sessionId, draftRevision)
          redrawDraft(n => n + 1)
        }
        resolve(result)
      })
    })
  }

  async function consumeSubmittedPrompt(
    sessionId: string,
    text: string,
    resolveAcceptance: (result: PromptResult) => void,
  ): Promise<void> {
    const requestId = crypto.randomUUID()
    let accepted = false
    let recover = false
    stopRecovery(sessionId)
    sessionRuntime.begin(sessionId, requestId, text)
    syncRuntimeView(sessionId)
    try {
      await consumePromptStream(
        sessionId, text,
        event => handleStreamEvent(sessionId, requestId, event),
        () => { accepted = true; resolveAcceptance({ ok: true }) },
      )
      // EOF alone is not evidence that the server run is terminal.
      recover = true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!accepted) resolveAcceptance({ ok: false, error: { message } })
      recover = accepted
      sessionRuntime.event(sessionId, requestId, { type: 'error', message })
    } finally {
      sessionRuntime.end(sessionId, requestId, recover)
      syncRuntimeView(sessionId)
      startRecovery(sessionId)
      void refreshSessions().catch(() => {})
    }
  }

  async function sendPrompt(value: string): Promise<void> {
    await submitPrompt(value, 'composer')
  }

  submitPromptRef.current = submitPrompt

  async function handleAbort() {
    const owner = selectedSessionIdRef.current
    if (!owner || !sessionRuntime.isRunning(owner) || sessionRuntime.view(owner).aborting) return
    sessionRuntime.aborting(owner, true)
    syncRuntimeView(owner)
    try {
      await abortSession(owner)
      startRecovery(owner)
    } catch (err) {
      sessionRuntime.aborting(owner, false)
      sessionRuntime.error(owner, `中断失败：${err instanceof Error ? err.message : String(err)}`)
      syncRuntimeView(owner)
    }
  }

  function handleConfirmAction() {
    const selectedPlanText = selectedPlan
      ? selectedPlan.value
        ? `我选择 ${selectedPlan.label}：${selectedPlan.value}，确认执行。`
        : `我选择${selectedPlan.label}，确认执行。`
      : '确认'
    clearPendingConfirmLocal()
    void sendPrompt(selectedPlanText)
  }

  async function handleCancelConfirm() {
    clearPendingConfirmLocal({ dismiss: true })
    if (!selectedSessionId) return
    try {
      const detail = await clearPendingConfirm(selectedSessionId)
      setSession(detail)
      setStatus('已取消确认')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : '取消确认失败')
    }
  }

  function handleComparePlans() {
    if (!pendingConfirm) return
    clearPendingConfirmLocal()
    void sendPrompt([
      '请对比这些候选方案，简要说明各自优缺点、适用场景和推荐选择。',
      `候选方案内容是：\n${pendingConfirm.message}`,
      '先不要执行。',
    ].join('\n\n'))
  }

  function handleEditConfirm() {
    setConfirmEditorOpen(true)
    setConfirmDraft('')
  }

  function buildConfirmEditPrompt(feedback: string): string {
    if (!pendingConfirm) return feedback
    const selectedPlanLine = selectedPlan
      ? `用户当前选择的是：${selectedPlan.label}${selectedPlan.value ? `：${selectedPlan.value}` : ''}`
      : ''
    if (pendingConfirm.allowWrite) {
      return [
        '用户正在修改待确认的方案（含写权限）。',
        `原待确认内容是：\n${pendingConfirm.message}`,
        selectedPlanLine,
        `用户修改意见是：\n${feedback}`,
        '请根据修改意见重新设计方案；如果修改意见改变了任务范围，先 confirm() 对齐理解，否则返回新的 confirm(allow_write)。',
        '不要写代码。',
      ].filter(Boolean).join('\n\n')
    }

    return [
      '用户正在修改待确认的内容。',
      `原待确认内容是：\n${pendingConfirm.message}`,
      selectedPlanLine,
      `用户修改意见是：\n${feedback}`,
      '请根据修改意见重新调整；如信息足够，返回新的 confirm；如信息不足，ask_user。',
      '不要写代码。',
    ].filter(Boolean).join('\n\n')
  }

  function handleSubmitConfirmEdit() {
    if (!pendingConfirm || !confirmDraft.trim()) return
    const editPrompt = buildConfirmEditPrompt(confirmDraft.trim())
    clearPendingConfirmLocal()
    void sendPrompt(editPrompt)
  }

  const statusLabel = useMemo(() => {
    if (aborting) return status || '正在中断'
    if (running) return deltaCount > 0 ? `生成中 · ${deltaCount}` : status || modelThinkingStatus
    return status
  }, [aborting, deltaCount, running, status])

  const workspaceSubtitle = useMemo(() => {
    if (viewMode === 'metrics') return '会话监控信息'
    if (pendingConfirm) return `等待确认：${pendingConfirm.allowWrite ? '代码修改' : '内容'}`
    return '本地 Agent 工作台'
  }, [pendingConfirm, viewMode])

  const activitySummary = useMemo(() => {
    const latest = activityItems.at(-1)?.content || (running ? '等待模型生成或选择下一步行动' : '暂无执行过程')
    return {
      latest,
      count: activityItems.length,
    }
  }, [activityItems, running])

  const showActivityPanel = (running && !aborting) || activityItems.length > 0
  const activityPanelTitle = aborting
    ? '正在中断'
    : running && activityItems.length === 0
    ? modelThinkingStatus
    : running
      ? '正在执行'
      : '执行过程'

  const memoryMode = sessionMemory?.settings.recallMode || session?.state.memorySettings?.recallMode || 'auto'
  const metricCalls = metrics?.calls || []
  const metricMaxTotalTokens = Math.max(0, ...metricCalls.map((call) => call.promptTokens + call.completionTokens))
  const metricMaxLatency = Math.max(0, ...metricCalls.map((call) => call.latencyMs))
  const metricMaxFirstToken = Math.max(0, ...metricCalls.map((call) => call.firstTokenMs))
  const metricAnomalies = useMemo(() => {
    if (!metrics || metrics.calls.length === 0) return []
    const averageTokens = metrics.summary.callCount === 0
      ? 0
      : metrics.summary.totalTokens / metrics.summary.callCount
    return metrics.calls
      .map((call, index) => {
        const totalTokens = call.promptTokens + call.completionTokens
        const reasons = [
          averageTokens > 0 && totalTokens >= averageTokens * 2 ? 'Token 偏高' : '',
          metrics.summary.averageLatencyMs > 0 && call.latencyMs >= metrics.summary.averageLatencyMs * 2 ? '延迟偏高' : '',
          metrics.summary.averageFirstTokenMs > 0 && call.firstTokenMs >= metrics.summary.averageFirstTokenMs * 2 ? '首 Token 偏慢' : '',
        ].filter(Boolean)
        return { call, index, totalTokens, reasons }
      })
      .filter((item) => item.reasons.length > 0)
  }, [metrics])
  const metricsViewOptions: Array<{ key: MetricsViewMode; label: string; icon: typeof List }> = [
    { key: 'detail', label: '明细', icon: List },
    { key: 'trend', label: '趋势', icon: TrendingUp },
    { key: 'anomaly', label: '异常', icon: AlertTriangle },
    { key: 'composition', label: '构成', icon: PieChart },
  ]
  const themeButtonTitle = themeMode === 'dark' ? '切换浅色模式' : '切换暗色模式'
  const appShellClassName = [
    'appShell',
    sidebarCollapsed ? 'sidebarCollapsed' : '',
    themeMode === 'light' ? 'themeLight' : 'themeDark',
  ].filter(Boolean).join(' ')
  const memoryLayers = sessionMemory?.layers || []
  const memoryTotal = memoryLayers.reduce((sum, layer) => sum + layer.items.length, 0)
  const selectedMemoryLayer = memoryLayers.find((layer) => layer.id === activeMemoryLayer) || memoryLayers[0] || null

  return (
    <main className={appShellClassName}>
      <aside className="sidebar">
        <section className="brandBlock">
          <div>
            <h1>Agent Console</h1>
            <p>{statusLabel}</p>
          </div>
          <div className="brandActions">
            <button
              className="iconButton"
              title={themeButtonTitle}
              aria-label={themeButtonTitle}
              onClick={() => setThemeMode((current) => (current === 'dark' ? 'light' : 'dark'))}
            >
              {themeMode === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button className="iconButton" title="刷新" onClick={() => startRecovery(selectedSessionId)}>
              <RefreshCcw size={18} />
            </button>
            <button className="iconButton" title="收起侧边栏" onClick={() => setSidebarCollapsed(true)}>
              <PanelLeftClose size={18} />
            </button>
          </div>
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
              editingSessionId === item.id ? (
                <div
                  key={item.id}
                  className={item.id === selectedSessionId ? 'sessionItem active editing' : 'sessionItem editing'}
                >
                  <div className="sessionItemMeta">
                    <input
                      className="sessionTitleInput"
                      value={editingSessionTitle}
                      onChange={(event) => setEditingSessionTitle(event.target.value)}
                      onKeyDown={(event) => handleSessionTitleKeyDown(event, item.id)}
                      onBlur={() => {
                        if (skipSessionRenameBlurRef.current === item.id) {
                          skipSessionRenameBlurRef.current = ''
                          return
                        }
                        void submitSessionRename(item.id)
                      }}
                      placeholder={item.id}
                      autoFocus
                    />
                    <small>{item.id}</small>
                  </div>
                  <small>{formatTime(item.updatedAt)}</small>
                </div>
              ) : (
                <button
                  key={item.id}
                  className={item.id === selectedSessionId ? 'sessionItem active' : 'sessionItem'}
                  onClick={() => setSelectedSessionId(item.id)}
                  onContextMenu={(event) => handleSessionContextMenu(event, item.id)}
                  title="右键可编辑会话名称"
                >
                  <div className="sessionItemMeta">
                    <span>{displaySessionTitle(item)}</span>
                  </div>
                  <small>{formatTime(item.updatedAt)}</small>
                </button>
              )
            ))}
          </div>
          {sessionContextMenu ? (
            <div
              ref={contextMenuRef}
              className="contextMenu"
              style={{
                left: `${sessionContextMenu.x}px`,
                top: `${sessionContextMenu.y}px`,
              }}
            >
              <button onClick={() => openSessionRename(sessionContextMenu.sessionId)}>
                <Pencil size={15} />
                编辑名称
              </button>
              <button onClick={() => void handleDownloadSession(sessionContextMenu.sessionId)}>
                <Download size={15} />
                下载会话
              </button>
              <button className="danger" onClick={() => void handleDeleteSession(sessionContextMenu.sessionId)}>
                <Trash2 size={15} />
                删除会话
              </button>
            </div>
          ) : null}
        </section>

        <section className="panel memoryPanel">
          <div className="panelHeader">
            <span>记忆</span>
            <small>{memoryMode} · {memoryTotal}</small>
          </div>
          <div className="memoryModeStack" role="group" aria-label="记忆召回模式">
            {(['auto', 'off', 'on'] as MemoryRecallMode[]).map((mode) => (
              <button
                type="button"
                key={mode}
                className={memoryMode === mode ? 'memoryModeButton active' : 'memoryModeButton'}
                disabled={!selectedSessionId || memoryBusy}
                onClick={() => void handleMemoryModeChange(mode)}
              >
                {mode === 'auto' ? 'Auto' : mode === 'off' ? 'Off' : 'On'}
              </button>
            ))}
          </div>
          <div className="memorySummary">
            {memoryLayers.map((layer) => (
              <span key={layer.id}>{layer.label}: {layer.items.length}</span>
            ))}
            {memoryLayers.length === 0 ? <span>暂无记忆信息</span> : null}
          </div>
          {memoryError ? <div className="memoryError">{memoryError}</div> : null}
          <button
            type="button"
            className="memoryManageButton"
            disabled={!selectedSessionId}
            onClick={() => {
              setMemoryManagerOpen(true)
              void refreshMemory()
            }}
          >
            <Settings2 size={16} />
            管理记忆
          </button>
        </section>

        <section className="panel skillPanel">
          <div className="panelHeader">
            <span>SKILL</span>
            <small>{enabledSkillCount}/{skills.length}</small>
          </div>
          <div className="skillPanelSummary">
            <span className="skillStatusDot enabled" />
            <span>{enabledSkillCount} 启用</span>
            <span className="skillStatusDot" />
            <span>{skills.length - enabledSkillCount} 卸载</span>
          </div>
          <div className="skillPanelActions">
            <button type="button" disabled={skillsBusy} onClick={handleUploadSkillClick}>
              <FileUp size={16} />
              上传
            </button>
            <button
              type="button"
              disabled={skillsBusy}
              onClick={() => {
                setSkillContextMenu(null)
                setSkillManagerOpen(true)
                void refreshSkills()
              }}
            >
              <Settings2 size={16} />
              管理
            </button>
          </div>
          <input
            ref={skillUploadInputRef}
            type="file"
            accept=".md,text/markdown"
            className="hiddenFileInput"
            onChange={(event) => void handleSkillFileSelected(event)}
          />
          {skillError ? <div className="skillError">{skillError}</div> : null}
        </section>
      </aside>

      <aside className="collapsedRail" aria-label="已收起的侧边栏">
        <div className="railActions">
          <button
            className="iconButton"
            title={themeButtonTitle}
            aria-label={themeButtonTitle}
            onClick={() => setThemeMode((current) => (current === 'dark' ? 'light' : 'dark'))}
          >
            {themeMode === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className="iconButton" title="展开侧边栏" onClick={() => setSidebarCollapsed(false)}>
            <PanelLeftOpen size={18} />
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="workspaceHeader">
          <div className="workspaceTitle">
            <h2>{selectedSessionSummary ? displaySessionTitle(selectedSessionSummary) : '未选择会话'}</h2>
            <p>{workspaceSubtitle}</p>
          </div>

          <section className="workspaceControls">
            <div className="controlGroup repositoryControl">
              <button
                className="openRepositoryButton"
                disabled={!selectedSessionId}
                onClick={openRepositoryEditor}
                title={repository.repoUrl ? repository.repoUrl : '编辑当前会话仓库'}
              >
                <GitPullRequest size={17} />
                编辑仓库
              </button>
            </div>

            <div className="controlGroup pathControl">
              <button className="choosePathButton" disabled={!selectedSessionId} onClick={() => void handlePickDirectory()}>
                <FolderOpen size={17} />
                选择操作目录
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

        </header>

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

                <section className="metricsModeTabs" aria-label="监控展示方式">
                  {metricsViewOptions.map((option) => {
                    const Icon = option.icon
                    return (
                      <button
                        key={option.key}
                        type="button"
                        className={metricsViewMode === option.key ? 'active' : ''}
                        onClick={() => setMetricsViewMode(option.key)}
                      >
                        <Icon size={16} />
                        {option.label}
                      </button>
                    )
                  })}
                </section>

                {metricsViewMode === 'detail' ? (
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
                        {metricCalls.map((call, index) => (
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
                    {metricCalls.length === 0 ? <div className="emptyMetrics">当前会话还没有模型调用记录</div> : null}
                  </section>
                ) : null}

                {metricsViewMode === 'trend' ? (
                  <section className="metricsTrendPanel">
                    {metricCalls.length === 0 ? <div className="emptyMetrics">当前会话还没有模型调用记录</div> : null}
                    {metricCalls.map((call, index) => {
                      const totalTokens = call.promptTokens + call.completionTokens
                      return (
                        <article className="metricsTrendRow" key={`${call.timestamp}-${index}`}>
                          <div className="metricCallIndex">#{index + 1}</div>
                          <div className="metricTrendBars">
                            <div className="metricTrendLine token">
                              <span style={{ width: `${percentOf(totalTokens, metricMaxTotalTokens)}%` }} />
                            </div>
                            <div className="metricTrendLine latency">
                              <span style={{ width: `${percentOf(call.latencyMs, metricMaxLatency)}%` }} />
                            </div>
                            <div className="metricTrendLine firstToken">
                              <span style={{ width: `${percentOf(call.firstTokenMs, metricMaxFirstToken)}%` }} />
                            </div>
                          </div>
                          <div className="metricTrendValues">
                            <strong>{formatNumber(totalTokens)} token</strong>
                            <span>{formatDuration(call.latencyMs)} / {formatDuration(call.firstTokenMs)}</span>
                          </div>
                        </article>
                      )
                    })}
                    {metricCalls.length > 0 ? (
                      <div className="metricLegend">
                        <span className="token">Token</span>
                        <span className="latency">延迟</span>
                        <span className="firstToken">首 Token</span>
                      </div>
                    ) : null}
                  </section>
                ) : null}

                {metricsViewMode === 'anomaly' ? (
                  <section className="metricsAnomalyGrid">
                    {metricAnomalies.length === 0 ? (
                      <div className="emptyMetrics">未发现明显异常调用</div>
                    ) : null}
                    {metricAnomalies.map((item) => (
                      <article className="metricsAnomalyCard" key={`${item.call.timestamp}-${item.index}`}>
                        <div>
                          <strong>#{item.index + 1}</strong>
                          <span>{item.call.timestamp ? formatTime(item.call.timestamp) : '-'}</span>
                        </div>
                        <p>{item.reasons.join(' / ')}</p>
                        <dl>
                          <div>
                            <dt>Token</dt>
                            <dd>{formatNumber(item.totalTokens)}</dd>
                          </div>
                          <div>
                            <dt>延迟</dt>
                            <dd>{formatDuration(item.call.latencyMs)}</dd>
                          </div>
                          <div>
                            <dt>首 Token</dt>
                            <dd>{formatDuration(item.call.firstTokenMs)}</dd>
                          </div>
                        </dl>
                      </article>
                    ))}
                  </section>
                ) : null}

                {metricsViewMode === 'composition' ? (
                  <section className="metricsCompositionPanel">
                    {metricCalls.length === 0 ? <div className="emptyMetrics">当前会话还没有模型调用记录</div> : null}
                    {metricCalls.map((call, index) => {
                      const totalTokens = call.promptTokens + call.completionTokens
                      const promptPercent = totalTokens > 0 ? Math.round((call.promptTokens / totalTokens) * 100) : 0
                      const completionPercent = totalTokens > 0 ? 100 - promptPercent : 0
                      return (
                        <article className="metricsCompositionRow" key={`${call.timestamp}-${index}`}>
                          <div className="metricCallIndex">#{index + 1}</div>
                          <div className="compositionStack" aria-label={`第 ${index + 1} 次调用 Token 构成`}>
                            <span className="prompt" style={{ width: `${promptPercent}%` }} />
                            <span className="completion" style={{ width: `${completionPercent}%` }} />
                          </div>
                          <div className="compositionValues">
                            <strong>{formatNumber(totalTokens)}</strong>
                            <span>P {promptPercent}% / C {completionPercent}%</span>
                          </div>
                        </article>
                      )
                    })}
                    {metricCalls.length > 0 ? (
                      <div className="metricLegend">
                        <span className="prompt">Prompt</span>
                        <span className="completion">Completion</span>
                      </div>
                    ) : null}
                  </section>
                ) : null}
              </>
            )}
          </div>
        ) : (
          <div className="timeline" ref={timelineRef}>
            {timeline.length === 0 && activityItems.length === 0 && !running ? (
              <div className="emptyState">新会话已准备好</div>
            ) : (
              <>
                {timeline.map((item, index) => (
                  <article key={item.id} className={`bubble ${item.role}`}>
                    <pre>{item.content}</pre>
                    {item.role === 'assistant' ? (
                      <div className="responseActions" aria-label="模型回复操作" onMouseLeave={() => setCopiedResponseId('')}>
                        <button
                          className={copiedResponseId === item.id ? 'copied' : ''}
                          title={copiedResponseId === item.id ? '已复制' : '复制回复'}
                          onClick={() => void handleCopyResponse(item.id, item.content)}
                        >
                          {copiedResponseId === item.id ? <Check size={17} /> : <Copy size={17} />}
                        </button>
                        {responseFeedback[item.id] !== 'down' ? (
                          <button
                            className={responseFeedback[item.id] === 'up' ? 'active' : ''}
                            title="赞"
                            onClick={() => handleFeedback(item.id, 'up')}
                          >
                            <ThumbsUp size={17} />
                          </button>
                        ) : null}
                        <button
                          className={responseFeedback[item.id] === 'down' ? 'active' : ''}
                          title="踩"
                          onClick={() => handleNegativeFeedback(item.id, item.content)}
                        >
                          <ThumbsDown size={17} />
                        </button>
                        <button title="重新生成" disabled={running} onClick={() => handleRegenerate(index)}>
                          <RefreshCcw size={17} />
                        </button>
                      </div>
                    ) : null}
                  </article>
                ))}
                {showActivityPanel ? (
                  <section className="activityPanel" aria-label="执行过程">
                    <button
                      className={activityItems.length === 0 ? 'activitySummary thinking' : 'activitySummary'}
                      disabled={activityItems.length === 0}
                      onClick={() => setActivityExpanded((expanded) => !expanded)}
                    >
                      <span className="activityPulse" />
                      <span>
                        <strong>{activityPanelTitle}</strong>
                        <small>
                          {activityItems.length > 0
                            ? `${activitySummary.count} 条记录 · ${activitySummary.latest}`
                            : activitySummary.latest}
                        </small>
                      </span>
                      <em>{activityItems.length > 0 ? (activityExpanded ? '收起' : '详情') : '等待'}</em>
                    </button>
                    {activityExpanded && activityItems.length > 0 ? (
                      <ol className="activityList">
                        {activityItems.map((item) => (
                          <li key={item.id}>{item.content}</li>
                        ))}
                      </ol>
                    ) : null}
                  </section>
                ) : null}
              </>
            )}
          </div>
        )}

        {pendingConfirm ? (
          <div className="confirmBar">
            {pendingConfirm.allowWrite ? (
              <div className="confirmWarning" role="alert">
                {allowWriteConfirmWarning}
              </div>
            ) : null}
            {confirmEditorOpen ? (
              <div className="confirmEditRow">
                <textarea
                  value={confirmDraft}
                  onChange={(event) => setConfirmDraft(event.target.value)}
                  placeholder={`输入你想调整的内容`}
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
              </div>
            ) : (
              <>
                {hasPlanChoices && !selectedPlan ? (
                  <div className="confirmChoiceRow">
                    <span>选择一个方案继续</span>
                    <div className="confirmActions">
                      {pendingPlanOptions.map((option) => (
                        <button
                          key={option.key}
                          className="primary"
                          onClick={() => setSelectedPlanKey(option.key)}
                        >
                          {option.label}
                        </button>
                      ))}
                      <button className="secondary" onClick={handleComparePlans}>让 Agent 对比</button>
                      <button className="secondary" onClick={handleEditConfirm}>我想调整</button>
                      <button className="secondary" onClick={handleCancelConfirm}>取消</button>
                    </div>
                  </div>
                ) : (
                  <div className="confirmChoiceRow">
                    {selectedPlan ? <span>已选择 {selectedPlan.label}</span> : null}
                    <div className="confirmActions">
                      <button className="primary" onClick={handleConfirmAction}>
                        <CheckCircle2 size={18} />
                        确认执行
                      </button>
                      {selectedPlan ? (
                        <button className="secondary" onClick={() => setSelectedPlanKey('')}>重选方案</button>
                      ) : null}
                      <button className="secondary" onClick={handleEditConfirm}>继续调整</button>
                      <button className="secondary" onClick={handleCancelConfirm}>取消</button>
                    </div>
                  </div>
                )}
              </>
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
          <div className="composerPluginActions">
            <SlotOutlet
              runtime={pluginRuntime}
              name="conversation.input.left"
              sessionId={selectedSessionId}
              owner={{}}
            />
          </div>
          <textarea
            ref={promptTextareaRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="输入需求或问题"
            disabled={session?.id !== selectedSessionId || !selectedSessionId || running}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void sendPrompt(prompt)
              }
            }}
          />
          {running ? (
            <button className="sendButton abort" title={aborting ? '正在停止' : '停止'} type="button" disabled={aborting} onClick={() => void handleAbort()}>
              <CircleStop size={19} />
            </button>
          ) : (
            <button className="sendButton" title="发送" disabled={!prompt.trim() || !selectedSessionId || session?.id !== selectedSessionId}>
              <Send size={19} />
            </button>
          )}
        </form>
      </section>

      {directoryPickerOpen ? (
        <div className="modalBackdrop">
          <section className="directoryModal" aria-label="选择操作目录">
            <header>
              <div>
                <h3>选择操作目录</h3>
                <p>{directoryBusy ? '正在读取文件夹…' : directoryError ? '读取失败，请重新输入或返回主目录' : directoryListing?.path || '请选择文件夹'}</p>
              </div>
              <button className="miniIconButton static" title="关闭" onClick={closeDirectoryPicker}>
                <X size={17} />
              </button>
            </header>

            {directoryError ? <div className="directoryError">{directoryError}</div> : null}
            <form className="directoryToolbar" onSubmit={event => { event.preventDefault(); if (directoryPathInput.trim()) void openDirectoryPicker(directoryPathInput.trim()) }}>
              <input aria-label="文件夹绝对路径" placeholder="输入文件夹绝对路径" value={directoryPathInput} onChange={event => setDirectoryPathInput(event.target.value)} />
              <button disabled={directoryBusy || !directoryPathInput.trim()}>打开路径</button>
            </form>
            {directoryBusy ? <p role="status">正在读取或保存目录…</p> : null}

            <div className="directoryToolbar">
              <button
                disabled={directoryBusy || (!directoryListing?.parentPath && !(directoryListing?.canListRoots && !directoryListing.isRootListing))}
                onClick={openDirectoryParent}
              >
                {directoryListing?.parentPath ? '上一级' : '盘符列表'}
              </button>
              <button disabled={directoryBusy} onClick={() => void openDirectoryPicker(undefined, { home: true })}>主目录</button>
              <button disabled={directoryBusy} onClick={() => void openDirectoryPicker(undefined, { roots: true })}>磁盘根目录</button>
              <button disabled={directoryBusy || !!directoryError || !directoryListing || directoryListing.isRootListing} onClick={() => directoryListing && void chooseDirectory(directoryListing.path)}>
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

      {memoryManagerOpen ? (
        <div className="modalBackdrop">
          <section className="memoryManagerModal" aria-label="记忆管理">
            <header>
              <div>
                <h3>记忆管理</h3>
                <p>会话、项目和全局记忆分别存放，召回关闭时不会注入 Agent 上下文。</p>
              </div>
              <button className="miniIconButton static" title="关闭" onClick={() => setMemoryManagerOpen(false)}>
                <X size={17} />
              </button>
            </header>

            <div className="memoryLayerTabs">
              {memoryLayers.map((layer) => (
                <button
                  key={layer.id}
                  className={activeMemoryLayer === layer.id ? 'active' : ''}
                  onClick={() => setActiveMemoryLayer(layer.id)}
                >
                  {layer.label}
                  <small>{layer.items.length}</small>
                </button>
              ))}
            </div>

            {memoryError ? <div className="skillManagerError">{memoryError}</div> : null}

            {selectedMemoryLayer ? (
              <div className="memoryManagerBody">
                <section className="memoryLayerInfo">
                  <div>
                    <strong>{selectedMemoryLayer.label}</strong>
                    <span>{selectedMemoryLayer.scope}</span>
                    <span>手动记忆和自动记忆都会显示在这里。</span>
                    {selectedMemoryLayer.id === 'project' && sessionMemory?.projectInfo ? (
                      <span>Project: {sessionMemory.projectInfo.displayName}</span>
                    ) : null}
                  </div>
                  <div className="memoryPathPill">
                    <span>索引</span>
                    <code>{selectedMemoryLayer.paths.index}</code>
                  </div>
                </section>

                <select
                  className="memoryTypeSelect"
                  value={activeMemoryType}
                  onChange={(event) => setActiveMemoryType(event.target.value as MemoryType)}
                  disabled={!selectedSessionId || memoryBusy}
                >
                  <option value="project">project</option>
                  <option value="feedback">feedback</option>
                  <option value="user">user</option>
                  <option value="reference">reference</option>
                </select>

                <div className="memoryComposer">
                  <textarea
                    value={memoryDraft}
                    onChange={(event) => setMemoryDraft(event.target.value)}
                    placeholder={`写入${selectedMemoryLayer.label}`}
                    disabled={!selectedSessionId || memoryBusy}
                  />
                  <button
                    type="button"
                    className="miniActionButton"
                    title="添加记忆"
                    disabled={!memoryDraft.trim() || !selectedSessionId || memoryBusy}
                    onClick={() => void handleSaveMemoryItem()}
                  >
                    <Plus size={16} />
                  </button>
                </div>

                <div className="memoryManagerList">
                  {selectedMemoryLayer.items.map((item) => (
                    <article
                      className="memoryItem clickable"
                      key={item.id}
                      title="打开记忆文件位置"
                      onClick={() => void handleRevealMemoryItem(item.layer, item.name)}
                    >
                      <p>
                        <strong>{item.name}</strong> <span>[{item.type}]</span>
                        <br />
                        {item.description}
                        <br />
                        <small>{item.filePath}</small>
                        {item.content ? (
                          <>
                            <br />
                            <em>{item.content.slice(0, 140)}{item.content.length > 140 ? '...' : ''}</em>
                          </>
                        ) : null}
                      </p>
                      <button
                        type="button"
                        className="miniIconButton static"
                        title="删除记忆"
                        onClick={(event) => {
                          event.stopPropagation()
                          void handleDeleteMemoryItem(item.name)
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </article>
                  ))}
                  {selectedMemoryLayer.items.length === 0 ? <div className="memoryEmpty">暂无记忆</div> : null}
                </div>
              </div>
            ) : (
              <div className="memoryEmpty">暂无记忆信息</div>
            )}
          </section>
        </div>
      ) : null}

      {skillManagerOpen ? (
        <div className="modalBackdrop">
          <section className="skillManagerModal" aria-label="Skill 管理">
            <header>
              <div>
                <h3>Skill 管理</h3>
                <p>启用的 Skill 会进入 Agent 的渐进式披露上下文；卸载后文件仍保留。</p>
              </div>
              <button className="miniIconButton static" title="关闭" onClick={() => {
                setSkillContextMenu(null)
                setSkillManagerOpen(false)
              }}>
                <X size={17} />
              </button>
            </header>

            {skillError ? <div className="skillManagerError">{skillError}</div> : null}

            <div className="skillManagerList">
              {sortedSkills.map((skill) => (
                <article
                  className="skillManagerItem"
                  key={skill.id}
                  onContextMenu={(event) => handleSkillContextMenu(event, skill.id)}
                >
                  <button
                    type="button"
                    className={skill.enabled ? 'skillLampButton enabled' : 'skillLampButton disabled'}
                    title={skill.enabled ? '卸载 Skill' : '启用 Skill'}
                    disabled={skillsBusy}
                    onClick={() => void handleSkillEnabled(skill, !skill.enabled)}
                  >
                    <span className={skill.enabled ? 'skillStatusDot enabled' : 'skillStatusDot'} />
                  </button>
                  <div className="skillManagerMain">
                    <strong>{skill.name}</strong>
                    <span>{skill.summary || skill.description}</span>
                  </div>
                  <div className="skillManagerMeta">
                    <small>{skill.enabled ? '启用' : '卸载'} / {skill.source === 'builtin' ? '内置' : '上传'}</small>
                    {skill.node || skill.entry ? <code>{skill.node || skill.entry}</code> : null}
                  </div>
                </article>
              ))}
              {sortedSkills.length === 0 ? <div className="skillManagerEmpty">暂无可用 Skill</div> : null}
            </div>

            {skillContextMenu && selectedSkillMenuItem ? (
              <div
                ref={skillContextMenuRef}
                className="contextMenu"
                style={{
                  left: `${skillContextMenu.x}px`,
                  top: `${skillContextMenu.y}px`,
                }}
              >
                <button
                  disabled={selectedSkillMenuItem.enabled || skillsBusy}
                  onClick={() => {
                    setSkillContextMenu(null)
                    void handleSkillEnabled(selectedSkillMenuItem, true)
                  }}
                >
                  <Power size={15} />
                  启用
                </button>
                <button
                  disabled={!selectedSkillMenuItem.enabled || skillsBusy}
                  onClick={() => {
                    setSkillContextMenu(null)
                    void handleSkillEnabled(selectedSkillMenuItem, false)
                  }}
                >
                  <PowerOff size={15} />
                  卸载
                </button>
                <button
                  className="danger"
                  disabled={selectedSkillMenuItem.source !== 'custom' || skillsBusy}
                  onClick={() => void handleDeleteSkill(selectedSkillMenuItem)}
                >
                  <Trash2 size={15} />
                  删除
                </button>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {repositoryEditorOpen ? (
        <div className="modalBackdrop">
          <section className="repositoryModal" aria-label="编辑仓库配置">
            <header>
              <div>
                <h3>编辑仓库</h3>
                <p>配置当前会话的仓库地址和 PR 默认参数</p>
              </div>
              <button className="miniIconButton static" title="关闭" onClick={() => setRepositoryEditorOpen(false)}>
                <X size={17} />
              </button>
            </header>
            <div className="repositoryModalBody">
              <div className="repositoryIdentityPanel">
                <div>
                  <span>GitHub 账号</span>
                  <strong>
                    {repositoryIdentityBusy
                      ? '检测中...'
                      : repositoryIdentity?.githubLogin || '未检测到 gh 登录'}
                  </strong>
                </div>
                <div>
                  <span>提交作者</span>
                  <strong>
                    {repositoryIdentityBusy
                      ? '检测中...'
                      : [
                          repositoryIdentity?.gitUserName,
                          repositoryIdentity?.gitUserEmail ? `<${repositoryIdentity.gitUserEmail}>` : '',
                        ].filter(Boolean).join(' ') || '未配置 git user'}
                  </strong>
                </div>
              </div>
              <div className="repositoryForm">
                <label>
                  <span>仓库地址</span>
                  <input
                    value={repositoryDraft.repoUrl || ''}
                    onChange={(event) => updateRepositoryDraft('repoUrl', event.target.value)}
                    placeholder="https://github.com/owner/repo.git"
                    disabled={!selectedSessionId || repositoryBusy}
                    autoFocus
                  />
                </label>
                <label>
                  <span>PR 目标</span>
                  <input
                    value={repositoryDraft.prRepoUrl || ''}
                    onChange={(event) => updateRepositoryDraft('prRepoUrl', event.target.value)}
                    placeholder="默认同仓库地址"
                    disabled={!selectedSessionId || repositoryBusy}
                  />
                </label>
                <label>
                  <span>源仓库</span>
                  <input
                    value={repositoryDraft.upstreamUrl || ''}
                    onChange={(event) => updateRepositoryDraft('upstreamUrl', event.target.value)}
                    placeholder="用于 fork/上游仓库"
                    disabled={!selectedSessionId || repositoryBusy}
                  />
                </label>
                <label>
                  <span>Base 分支</span>
                  <input
                    value={repositoryDraft.defaultBaseBranch || ''}
                    onChange={(event) => updateRepositoryDraft('defaultBaseBranch', event.target.value)}
                    placeholder="main"
                    disabled={!selectedSessionId || repositoryBusy}
                  />
                </label>
              </div>
              {repositoryError ? <div className="memoryError">{repositoryError}</div> : null}
              <div className="dockActions">
                <button onClick={() => setRepositoryEditorOpen(false)}>取消</button>
                <button disabled={!selectedSessionId || repositoryBusy} onClick={() => void handleSaveRepositoryConfig()}>
                  保存
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {negativeFeedbackDraft ? (
        <div className="modalBackdrop">
          <section className="feedbackModal" aria-label="反馈模型回复问题">
            <header>
              <div>
                <h3>反馈这条回复</h3>
                <p>哪里不太对？这些反馈会帮助我们改进体验。</p>
              </div>
              <button className="miniIconButton static" title="关闭" onClick={closeNegativeFeedback}>
                <X size={17} />
              </button>
            </header>
            <div className="feedbackBody">
              <div className="feedbackReasonGrid">
                {negativeFeedbackReasons.map((reason) => (
                  <button
                    key={reason}
                    className={negativeFeedbackDraft.reasons.includes(reason) ? 'selected' : ''}
                    onClick={() => toggleNegativeReason(reason)}
                  >
                    {reason}
                  </button>
                ))}
              </div>
              <textarea
                value={negativeFeedbackDraft.detail}
                onChange={(event) => setNegativeFeedbackDraft((current) => current ? { ...current, detail: event.target.value } : current)}
                placeholder="可以补充说明问题在哪里"
              />
              <div className="feedbackActions">
                <button onClick={closeNegativeFeedback}>取消</button>
                <button className="primary" onClick={submitNegativeFeedback}>提交反馈</button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  )
}
