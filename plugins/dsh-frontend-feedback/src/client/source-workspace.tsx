import { CodeEditor } from './CodeEditor.tsx'
import { createSourceDocument, editSourceDocument, resetSourceDocument, documentVersion, sameDocumentVersion, sameDocumentReplacementVersion, observeSourceConflict, sourceDocumentRaw, sourceDocumentDirty, sourceDocumentReadOnly, recoverSourceDocument } from './source-document.ts'
import type { SourceDocument, DocumentVersion } from './source-document.ts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import {
  PAGECRAFT_WORKSPACE_BLOB_PATH,
  PAGECRAFT_WORKSPACE_DIRECTORY_PATH,
  PAGECRAFT_WORKSPACE_ENTRY_PATH,
  PAGECRAFT_WORKSPACE_EVENTS_PATH,
  PAGECRAFT_WORKSPACE_FILE_PATH,
  PAGECRAFT_WORKSPACE_FOLDERS_PATH,
  PAGECRAFT_WORKSPACE_HISTORY_PATH,
  PAGECRAFT_WORKSPACE_PATH,
  PAGECRAFT_WORKSPACE_RESTORE_PATH,
  PAGECRAFT_WORKSPACE_TEXT_EDIT_PATH,
  PAGECRAFT_WORKSPACE_TEXT_VERIFY_PATH,
  workspaceFolderStorageKey,
  workspaceLayoutStorageKey,
} from '../workspace.ts'
import type {
  DirectTextEditResult,
  DirectTextEditStart,
  DomTextSelection,
  WorkspaceEntry,
  WorkspaceEvent,
  WorkspaceFile,
  WorkspaceHistoryEntry,
  WorkspaceSummary,
} from '../workspace.ts'
import {
  isDomTextSelection,
  isFeedbackSelection,
} from '../shared.ts'
import type {
  FeedbackSelection,
  SelectionMode,
} from '../shared.ts'
import {
  applyDirectoryListing,
  applyWorkspaceEvent,
  initialWorkspaceTreeState,
  setDirectoryLoading,
  toggleDirectory,
  workspaceEntryByPath,
} from './workspace-state.ts'
import type { WorkspaceTreeState } from './workspace-state.ts'
import {
  IndexedDbDraftStorage,
  SourceDraftCache,
  diskSaveStatus,
  isDraftCacheAllowed,
} from './source-drafts.ts'
import type { SourceDraftScope } from './source-drafts.ts'
import { normalizePresentationImageSlotSelection } from '../presentation.ts'
import type { PresentationImageSlotSelection } from '../presentation.ts'

interface WorkspaceExplorerProps {
  sessionId: string
  previewSrc: string | null
  onClose(): void
  onRefresh(): void
  onNavigate(url: string): void
  onAnnotationSelection(selection: FeedbackSelection): void
  onImageSlotSelection(selection: PresentationImageSlotSelection): void
}

type OpenFile = SourceDocument

interface PendingTextVerification {
  started: DirectTextEditStart
  selection: DomTextSelection
  expectedText: string
  timer: number
  epoch: number
  version?: DocumentVersion
}

interface StoredLayout {
  treeVisible?: boolean
  split?: number
  focus?: WorkspaceFocus
}

interface WorkspaceApiErrorBody {
  error?: { code?: string; message?: string; details?: unknown }
}

type WorkspaceFocus = 'split' | 'editor' | 'preview'

class WorkspaceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

function apiQuery(sessionId: string, values: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({ sessionId, ...values })
}

async function apiJson<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => null) as T & WorkspaceApiErrorBody | null
  if (!response.ok) {
    throw new WorkspaceApiError(
      value?.error?.message ?? `请求失败（HTTP ${response.status}）`,
      response.status,
      value?.error?.code ?? 'WORKSPACE_REQUEST_FAILED',
      value?.error?.details,
    )
  }
  return value as T
}

function readLayout(storageKey: string): Required<StoredLayout> {
  const fallback: Required<StoredLayout> = { treeVisible: true, split: 55, focus: 'split' }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? 'null') as StoredLayout | null
    if (parsed === null || typeof parsed !== 'object') return fallback
    const focus = parsed.focus === 'editor' || parsed.focus === 'preview' ? parsed.focus : 'split'
    const split = Number.isFinite(parsed.split) ? Math.min(75, Math.max(32, Number(parsed.split))) : 55
    return { treeVisible: parsed.treeVisible !== false, split, focus }
  } catch {
    return fallback
  }
}

function storeLayout(storageKey: string, value: Required<StoredLayout>): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value))
  } catch {
    // Layout persistence is optional; source files remain durable on disk.
  }
}

function TreeNode({ entry, depth, activePath, tree, onOpen, onToggle }: {
  entry: WorkspaceEntry
  depth: number
  activePath: string | null
  tree: WorkspaceTreeState
  onOpen(entry: WorkspaceEntry): void
  onToggle(entry: WorkspaceEntry): void
}): ReactElement {
  const isDirectory = entry.kind === 'directory'
  const expanded = tree.expanded.has(entry.path)
  const children = tree.children.get(entry.path) ?? []
  return (
    <div>
      <button
        type="button"
        title={entry.path}
        onClick={() => isDirectory ? onToggle(entry) : onOpen(entry)}
        style={{
          ...sourceStyles.treeItem,
          paddingLeft: 8 + depth * 13,
          ...(activePath === entry.path ? sourceStyles.treeItemActive : {}),
        }}
      >
        <span style={sourceStyles.treeIcon}>{isDirectory ? expanded ? '▾' : '▸' : entry.imagePreviewable ? '▧' : entry.textEditable ? '◇' : '·'}</span>
        <span style={sourceStyles.treeName}>{entry.name}</span>
        {tree.loading.has(entry.path) ? <span style={sourceStyles.lock}>●</span> : null}
      </button>
      {isDirectory && expanded ? children.map(child => (
        <TreeNode key={child.path} entry={child} depth={depth + 1} activePath={activePath} tree={tree} onOpen={onOpen} onToggle={onToggle} />
      )) : null}
    </div>
  )
}

function conflictCurrent(error: WorkspaceApiError): WorkspaceFile | null {
  if (error.code !== 'WORKSPACE_FILE_CONFLICT' || error.details === null || typeof error.details !== 'object') return null
  const current = (error.details as { current?: unknown }).current
  if (current === null || typeof current !== 'object') return null
  const candidate = current as WorkspaceFile
  return typeof candidate.path === 'string' && typeof candidate.content === 'string' && typeof candidate.hash === 'string'
    ? candidate
    : null
}

export function WorkspaceExplorer({
  sessionId,
  previewSrc,
  onClose,
  onRefresh,
  onNavigate,
  onAnnotationSelection,
  onImageSlotSelection,
}: WorkspaceExplorerProps): ReactElement {
  const fallbackLayoutKey = useMemo(() => `dsh-pagecraft.workspace-layout:${encodeURIComponent(sessionId)}`, [sessionId])
  const initialLayout = useMemo(() => readLayout(fallbackLayoutKey), [fallbackLayoutKey])
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null)
  const [selectedFolder, setSelectedFolder] = useState('.')
  const [tree, setTree] = useState<WorkspaceTreeState>(() => initialWorkspaceTreeState('.'))
  const [openFiles, renderOpenFiles] = useState<OpenFile[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [selectedEntry, setSelectedEntry] = useState<WorkspaceEntry | null>(null)
  const [treeVisible, setTreeVisible] = useState(initialLayout.treeVisible)
  const [split, setSplit] = useState(initialLayout.split)
  const [focus, setFocus] = useState<WorkspaceFocus>(initialLayout.focus)
  const [status, setStatus] = useState('正在读取当前 DSH 工作区…')
  const [busy, setBusy] = useState(false)
  const [pendingPersistence, setPendingPersistence] = useState(0)
  const [history, setHistory] = useState<WorkspaceHistoryEntry[]>([])
  const [historyDocumentId, setHistoryDocumentId] = useState<string | null>(null)
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  const [folderBrowsePath, setFolderBrowsePath] = useState('.')
  const [folderEntries, setFolderEntries] = useState<WorkspaceEntry[]>([])
  const [previewSelectionMode, setPreviewSelectionMode] = useState<SelectionMode | null>(null)
  const [textSelection, setTextSelection] = useState<DomTextSelection | null>(null)
  const [replacementText, setReplacementText] = useState('')
  const [textEditBusy, setTextEditBusy] = useState(false)
  const [revealLocation, setRevealLocation] = useState<{ path: string; line: number; revision: number } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const previewRef = useRef<HTMLIFrameElement>(null)
  const pendingVerificationRef = useRef<PendingTextVerification | null>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef(tree)
  const openFilesRef = useRef(openFiles)
  const refreshRequestsRef = useRef(new Map<string, symbol>())
  const draftCache = useMemo(() => new SourceDraftCache(new IndexedDbDraftStorage()), [])
  const lastSequenceRef = useRef(0)
  const loadedLayoutRootRef = useRef<string | null>(null)
  const active = openFiles.find(item => item.file.path === activePath) ?? null
  const dirty = active !== null && sourceDocumentDirty(active)
  const layoutKey = summary === null ? fallbackLayoutKey : workspaceLayoutStorageKey(summary.rootPath, sessionId)
  treeRef.current = tree
  const setOpenFiles = useCallback((update: OpenFile[] | ((items: OpenFile[]) => OpenFile[])): void => {
    const next = typeof update === 'function' ? update(openFilesRef.current) : update
    openFilesRef.current = next
    renderOpenFiles(next)
  }, [])
  const currentDocument = (item: OpenFile) => openFilesRef.current.find(open => open.documentId === item.documentId)
  const scopeEpoch = useRef(0)
  const sessionRef = useRef(sessionId)
  if (sessionRef.current !== sessionId) { sessionRef.current = sessionId; scopeEpoch.current++ }

  const draftScope = useCallback((path: string): SourceDraftScope | null => summary === null ? null : ({
    sessionId,
    rootPath: summary.rootPath,
    selectedFolder,
    path,
  }), [selectedFolder, sessionId, summary])

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent): void {
      if (pendingPersistence === 0 && !openFilesRef.current.some(item => sourceDocumentDirty(item))) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [pendingPersistence])

  useEffect(() => {
    storeLayout(layoutKey, { treeVisible, split, focus })
  }, [focus, layoutKey, split, treeVisible])

  useEffect(() => {
    if (summary === null || loadedLayoutRootRef.current === summary.rootPath) return
    const stored = readLayout(workspaceLayoutStorageKey(summary.rootPath, sessionId))
    loadedLayoutRootRef.current = summary.rootPath
    setTreeVisible(stored.treeVisible)
    setSplit(stored.split)
    setFocus(stored.focus)
  }, [sessionId, summary])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openFiles])

  const loadDirectory = useCallback(async (path: string, force = false): Promise<void> => {
    const current = treeRef.current
    if (!force && current.children.has(path) && !current.stale.has(path)) return
    setTree(value => setDirectoryLoading(value, path))
    try {
      const entries = await apiJson<WorkspaceEntry[]>(await fetch(
        `${PAGECRAFT_WORKSPACE_DIRECTORY_PATH}?${apiQuery(sessionId, { selectedFolder, path })}`,
        { cache: 'no-store' },
      ))
      setTree(value => applyDirectoryListing(value, path, entries))
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
      setTree(value => ({ ...value, loading: new Set(Array.from(value.loading).filter(item => item !== path)) }))
    }
  }, [selectedFolder, sessionId])

  async function connectFolder(nextFolder: string, rootPath?: string): Promise<void> {
    const epoch = ++scopeEpoch.current
    const next = await apiJson<WorkspaceSummary>(await fetch(
      `${PAGECRAFT_WORKSPACE_PATH}?${apiQuery(sessionId, { selectedFolder: nextFolder })}`,
      { cache: 'no-store' },
    ))
    if (epoch !== scopeEpoch.current) return
    setSummary(next)
    setSelectedFolder(next.selectedFolder)
    const nextTree = initialWorkspaceTreeState(next.selectedFolder)
    treeRef.current = nextTree
    setTree(nextTree)
    setSelectedEntry(null)
    setActivePath(null)
    setOpenFiles([])
    try {
      window.localStorage.setItem(workspaceFolderStorageKey(rootPath ?? next.rootPath, sessionId), next.selectedFolder)
    } catch {
      // Folder persistence is optional; files remain on disk.
    }
    const entries = await apiJson<WorkspaceEntry[]>(await fetch(
      `${PAGECRAFT_WORKSPACE_DIRECTORY_PATH}?${apiQuery(sessionId, { selectedFolder: next.selectedFolder, path: next.selectedFolder })}`,
      { cache: 'no-store' },
    ))
    if (epoch !== scopeEpoch.current) return
    setTree(value => applyDirectoryListing(value, next.selectedFolder, entries))
    setStatus(`已打开真实目录：${next.selectedPath}`)
  }

  async function loadWorkspace(): Promise<void> {
    const epoch = scopeEpoch.current
    setBusy(true)
    try {
      const root = await apiJson<WorkspaceSummary>(await fetch(
        `${PAGECRAFT_WORKSPACE_PATH}?${apiQuery(sessionId, { selectedFolder: '.' })}`,
        { cache: 'no-store' },
      ))
      if (epoch !== scopeEpoch.current) return
      let remembered = '.'
      try {
        remembered = window.localStorage.getItem(workspaceFolderStorageKey(root.rootPath, sessionId)) || '.'
      } catch {
        remembered = '.'
      }
      try {
        await connectFolder(remembered, root.rootPath)
      } catch {
        await connectFolder('.', root.rootPath)
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    setOpenFiles([])
    setActivePath(null)
    setHistory([])
    void loadWorkspace()
    return () => { scopeEpoch.current++ }
  }, [sessionId])

  const revealEditedFile = useCallback((file: WorkspaceFile, line: number, version?: DocumentVersion): void => {
    const scope = draftScope(file.path)
    if (scope === null) return
    setOpenFiles(items => {
      const existing = items.find(item => item.file.path === file.path)
      if (version !== undefined && (existing === undefined || existing.documentId !== version.documentId)) return items
      if (existing === undefined) return [...items, createSourceDocument(scope, file)]
      return items.map(item => {
        if (item.documentId !== existing.documentId) return item
        if (sourceDocumentDirty(item) || (version !== undefined && !sameDocumentReplacementVersion(item, version))) {
          return observeSourceConflict(item, file)
        }
        return resetSourceDocument(item, file)
      })
    })
    setActivePath(file.path)
    const entry = workspaceEntryByPath(treeRef.current, file.path)
    if (entry !== null) setSelectedEntry(entry)
    setRevealLocation(current => ({ path: file.path, line, revision: (current?.revision ?? 0) + 1 }))
  }, [draftScope, setOpenFiles])

  const completeTextVerification = useCallback(async (
    pending: PendingTextVerification,
    verified: boolean,
    observedText?: string,
  ): Promise<void> => {
    if (pendingVerificationRef.current?.started.transactionId !== pending.started.transactionId) return
    window.clearTimeout(pending.timer)
    pendingVerificationRef.current = null
    try {
      const result = await apiJson<DirectTextEditResult>(await fetch(
        `${PAGECRAFT_WORKSPACE_TEXT_VERIFY_PATH}?${apiQuery(sessionId)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            transactionId: pending.started.transactionId,
            verified,
            ...(observedText === undefined ? {} : { observedText }),
          }),
        },
      ))
      if (pending.epoch !== scopeEpoch.current) return
      setStatus(result.message)
      if (result.status === 'committed' && result.file !== undefined) {
        revealEditedFile(result.file, result.line, pending.version)
        setTextSelection(null)
        setReplacementText('')
      } else if (result.status === 'rolled_back') {
        window.setTimeout(onRefresh, 100)
      }
    } catch (error) {
      setStatus(`页面验证失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setTextEditBusy(false)
    }
  }, [onRefresh, revealEditedFile, sessionId])

  function postPreviewMode(mode: SelectionMode | null): void {
    previewRef.current?.contentWindow?.postMessage({
      type: 'dsh-frontend-feedback-set-mode',
      mode,
    }, '*')
  }

  function choosePreviewMode(mode: SelectionMode): void {
    const next = previewSelectionMode === mode ? null : mode
    setPreviewSelectionMode(next)
    postPreviewMode(next)
    if (next === 'text') setStatus('点击预览中要修改的文字。PageCraft 会自动追踪本地源码，不需要你选择代码位置。')
    else if (next === 'element') setStatus('点击预览中的 DOM 元素，选中后会返回共用评注队列。')
    else if (next === 'area') setStatus('在预览中拖动框选区域，确认后会返回共用评注队列。')
    else setStatus('已回到浏览模式。')
  }

  async function startDirectTextEdit(): Promise<void> {
    if (textSelection === null || textEditBusy || replacementText === textSelection.displayedText) return
    setTextEditBusy(true)
    setStatus('正在自动定位源码并写入本地文件…')
    const epoch = scopeEpoch.current
    const versions = openFilesRef.current.map(item => ({ path: item.file.path, version: documentVersion(item) }))
    try {
      const started = await apiJson<DirectTextEditStart>(await fetch(
        `${PAGECRAFT_WORKSPACE_TEXT_EDIT_PATH}?${apiQuery(sessionId)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ selectedFolder, selection: textSelection, replacementText }),
        },
      ))
      const pending: PendingTextVerification = {
        epoch,
        version: versions.find(item => item.path === started.path)?.version,
        started,
        selection: textSelection,
        expectedText: replacementText,
        timer: 0,
      }
      pending.timer = window.setTimeout(() => {
        void completeTextVerification(pending, false)
      }, 8_000)
      pendingVerificationRef.current = pending
      setStatus(`已修改 ${started.path}:${started.line}，正在刷新页面验证显示结果…`)
      onRefresh()
    } catch (error) {
      setTextEditBusy(false)
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  useEffect(() => {
    function onPreviewMessage(event: MessageEvent): void {
      if (event.source !== previewRef.current?.contentWindow) return
      const data = event.data as Record<string, unknown> | null
      if (data?.type === 'dsh-frontend-feedback-ready') {
        postPreviewMode(previewSelectionMode)
        const pending = pendingVerificationRef.current
        if (pending !== null) {
          previewRef.current?.contentWindow?.postMessage({
            type: 'dsh-pagecraft-verify-text',
            transactionId: pending.started.transactionId,
            selection: pending.selection,
            expectedText: pending.expectedText,
            timeoutMs: 6_500,
          }, '*')
        }
        return
      }
      if (data?.type === 'dsh-pagecraft-text-selected') {
        if (!isDomTextSelection(data.payload)) {
          setStatus('没有取得可靠的文字信息，请重新选择标题或段落。')
          return
        }
        setTextSelection(data.payload)
        setReplacementText(data.payload.displayedText)
        setPreviewSelectionMode(null)
        postPreviewMode(null)
        setStatus('已找到页面文字。输入新内容后点击“修改文字”。')
        return
      }
      if (data?.type === 'dsh-pagecraft-image-slot-selected') {
        const imageSlot = normalizePresentationImageSlotSelection(data)
        if (imageSlot === null) {
          setStatus('图片槽位信息无效，请刷新预览后重试。')
          return
        }
        setPreviewSelectionMode(null)
        postPreviewMode(null)
        setStatus(`已选择图片槽位：${imageSlot.label ?? imageSlot.slotId}`)
        onImageSlotSelection(imageSlot)
        return
      }
      if (data?.type === 'dsh-pagecraft-text-verification' && typeof data.transactionId === 'string') {
        const pending = pendingVerificationRef.current
        if (pending === null || pending.started.transactionId !== data.transactionId) return
        const observedText = typeof data.observedText === 'string' ? data.observedText : undefined
        const verified = data.found === true
          && (observedText ?? '').replace(/\s+/g, ' ').trim() === pending.expectedText.replace(/\s+/g, ' ').trim()
        void completeTextVerification(pending, verified, observedText)
        return
      }
      if (data?.type === 'dsh-frontend-feedback-selected') {
        if (!isFeedbackSelection(data.payload)) {
          setStatus('选中的 DOM 信息无法识别，请刷新后重试。')
          return
        }
        onAnnotationSelection(data.payload)
        onClose()
        return
      }
      if (data?.type === 'dsh-frontend-feedback-navigate' && typeof data.url === 'string') {
        onNavigate(data.url)
        return
      }
      if (data?.type === 'dsh-frontend-feedback-selection-error' || data?.type === 'dsh-frontend-feedback-navigation-error') {
        setStatus(typeof data.message === 'string' ? data.message : '当前操作没有完成，请重试。')
        return
      }
      if (data?.type === 'dsh-frontend-feedback-error') {
        setStatus(typeof data.message === 'string' ? `预览失败：${data.message}` : '预览加载失败。')
      }
    }
    window.addEventListener('message', onPreviewMessage)
    return () => window.removeEventListener('message', onPreviewMessage)
  }, [completeTextVerification, onAnnotationSelection, onClose, onImageSlotSelection, onNavigate, previewSelectionMode])

  useEffect(() => {
    return () => {
      const pending = pendingVerificationRef.current
      if (pending === null) return
      window.clearTimeout(pending.timer)
      pendingVerificationRef.current = null
      void fetch(`${PAGECRAFT_WORKSPACE_TEXT_VERIFY_PATH}?${apiQuery(sessionId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transactionId: pending.started.transactionId, verified: false }),
      }).catch(() => {})
    }
  }, [sessionId])

  async function openEntry(entry: WorkspaceEntry): Promise<void> {
    const epoch = scopeEpoch.current
    setSelectedEntry(entry)
    setActivePath(entry.path)
    if (!entry.textEditable) {
      setStatus(entry.imagePreviewable ? `正在预览 ${entry.path}` : `${entry.path} 是二进制或暂不支持编辑的文件。`)
      return
    }
    const existing = openFilesRef.current.find(item => item.file.path === entry.path)
    if (existing !== undefined) {
      return
    }
    setBusy(true)
    try {
      const query = apiQuery(sessionId, { selectedFolder, path: entry.path })
      const file = await apiJson<WorkspaceFile>(await fetch(`${PAGECRAFT_WORKSPACE_FILE_PATH}?${query}`, { cache: 'no-store' }))
      const scope = draftScope(file.path)
      if (scope === null || epoch !== scopeEpoch.current) return
      let opened = createSourceDocument(scope, file)
      if (scope !== null) {
        try {
          const restored = await draftCache.restore(scope, file.hash)
          if (epoch !== scopeEpoch.current) return
          if (restored.kind === 'recovered') {
            opened = recoverSourceDocument(opened, restored)
            setStatus(`已恢复 ${entry.path} 的浏览器草稿（尚未写入磁盘）。`)
          } else if (restored.kind === 'conflict') {
            opened = recoverSourceDocument(opened, restored)
            setStatus(`${entry.path} 的磁盘内容已变化，请处理恢复冲突。`)
          } else setStatus(`已打开 ${entry.path}`)
        } catch (error) {
          setStatus(`无法读取浏览器草稿：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (epoch !== scopeEpoch.current) return
      setOpenFiles(items => items.some(item => item.file.path === file.path) ? items : [...items, opened])
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  function closeTab(path: string): void {
    const item = openFiles.find(file => file.file.path === path)
    if (item !== undefined && sourceDocumentDirty(item) && !window.confirm(`${path} 还有未保存修改，确定关闭吗？`)) return
    const index = openFiles.findIndex(file => file.file.path === path)
    const remaining = openFiles.filter(file => file.file.path !== path)
    setOpenFiles(remaining)
    if (activePath === path) setActivePath(remaining[Math.max(0, index - 1)]?.file.path ?? null)
  }

  async function persistDocument(item: OpenFile): Promise<string | null> {
    if (!isDraftCacheAllowed(item.file.path)) return null
    setPendingPersistence(count => count + 1)
    try {
      const version = documentVersion(item)
      const result = await draftCache.persist(item.scope, item.file.hash, sourceDocumentRaw(item), item.format)
      if (!result.ok) return result.error.message
      const current = currentDocument(item)
      if (sameDocumentVersion(current, version)) {
        if (!sourceDocumentDirty(current!)) {
          await draftCache.clearSaved(item.scope, result.revision)
        } else {
          setOpenFiles(items => items.map(open => sameDocumentVersion(open, version) ? { ...open, draftRevision: result.revision } : open))
        }
      }
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    } finally { setPendingPersistence(count => Math.max(0, count - 1)) }
  }

  function updateDraft(value: string): void {
    const item = openFilesRef.current.find(candidate => candidate.file.path === activePath)
    if (item === undefined) return
    const next = editSourceDocument(item, value)
    if (next === item) return
    setOpenFiles(items => items.map(open => open.documentId === item.documentId ? next : open))
    if (!isDraftCacheAllowed(item.file.path)) {
      setStatus('安全提示：敏感文件草稿不会缓存在浏览器中；请及时保存到磁盘。')
      return
    }
    void persistDocument(next).then(error => {
      if (error !== null && currentDocument(next) !== undefined) setStatus(`浏览器草稿保存失败：${error} 请保存到磁盘后再关闭。`)
    })
  }

  async function writeFile(item: OpenFile, baseHash = item.file.hash): Promise<void> {
    if (sourceDocumentReadOnly(item)) return
    const version = documentVersion(item)
    const savedContent = sourceDocumentRaw(item)
    setBusy(true)
    try {
      const file = await apiJson<WorkspaceFile>(await fetch(
        `${PAGECRAFT_WORKSPACE_FILE_PATH}?${apiQuery(item.scope.sessionId)}`,
        { method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ selectedFolder: item.scope.selectedFolder, path: item.file.path, content: savedContent, baseHash }) },
      ))
      const latest = currentDocument(item)
      if (!sameDocumentVersion(latest, version, true)) return
      // Saving changes the base, not the view or its undo history.
      const newerConflict = latest!.conflictRevision !== version.conflictRevision && latest!.conflict?.hash !== file.hash ? latest!.conflict : null
      setOpenFiles(items => items.map(open => open.documentId === item.documentId ? observeSourceConflict({ ...open, file }, newerConflict) : open))
      let warning: string | null = null
      try {
        if (version.cacheRevision !== null) await draftCache.clearSaved(item.scope, version.cacheRevision)
        else await draftCache.clearMatching(item.scope, version.baseHash, savedContent)
      } catch (error) { warning = `磁盘已保存，但浏览器草稿清理失败：${error instanceof Error ? error.message : String(error)}` }
      const current = currentDocument(item)
      if (current === undefined || current.resetRevision !== version.resetRevision || current.file.hash !== file.hash) return
      if (sourceDocumentDirty(current)) {
        const error = await persistDocument(current)
        if (error !== null) warning = `磁盘已保存，但较新的浏览器草稿保存失败：${error} 较新的修改仍未保存。`
      } else {
        // ABA edits can persist a newer revision containing exactly the saved bytes.
        // Keep conditional deletion so a subsequent, different edit is never removed.
        try {
          await draftCache.clearMatching(item.scope, version.baseHash, savedContent)
          await draftCache.clearMatching(item.scope, file.hash, savedContent)
        } catch (error) { warning = `磁盘已保存，但浏览器草稿清理失败：${error instanceof Error ? error.message : String(error)}` }
        setOpenFiles(items => items.map(open => sameDocumentVersion(open, documentVersion(current)) ? { ...open, draftRevision: null } : open))
      }
      const newest = currentDocument(item)
      setStatus(diskSaveStatus(file.path, newest !== undefined && sourceDocumentDirty(newest), warning))
      window.setTimeout(onRefresh, 450)
    } catch (error) {
      const latest = currentDocument(item)
      if (!sameDocumentVersion(latest, version, true)) return
      if (error instanceof WorkspaceApiError) {
        const current = conflictCurrent(error)
        if (current !== null) {
          setOpenFiles(items => items.map(open => open.documentId === item.documentId ? observeSourceConflict(open, current) : open))
        }
      }
      setStatus(error instanceof Error ? error.message : String(error))
    } finally { setBusy(false) }
  }

  async function saveActive(): Promise<void> {
    if (active === null || !dirty || busy || active.conflict !== null || sourceDocumentReadOnly(active)) return
    await writeFile(active)
  }

  function handleClose(): void {
    if (openFilesRef.current.some(sourceDocumentDirty) && !window.confirm('还有未保存的修改，确定关闭文件工作区吗？')) return
    onClose()
  }

  async function discardDocument(item: OpenFile, disk = item.conflict ?? item.file): Promise<void> {
    const version = documentVersion(item)
    setBusy(true)
    try {
      await draftCache.discard(item.scope)
      const current = currentDocument(item)
      if (!sameDocumentReplacementVersion(current, version)) {
        if (current !== undefined) {
          const error = await persistDocument(current)
          setStatus(error === null
            ? `${item.file.path} 在丢弃期间有新的修改或磁盘版本；新修改已保留且仍未保存，请重新确认磁盘版本。`
            : `${item.file.path} 的新修改和磁盘冲突已保留，但浏览器草稿保存失败：${error}`)
        }
        return
      }
      setOpenFiles(items => items.map(open => open.documentId === item.documentId ? resetSourceDocument(open, disk) : open))
      setStatus(`已丢弃 ${item.file.path} 的浏览器草稿并载入磁盘版本。`)
    } catch (error) {
      if (currentDocument(item) !== undefined) setStatus(`无法丢弃浏览器草稿：${error instanceof Error ? error.message : String(error)}`)
    } finally { setBusy(false) }
  }

  async function discardActiveDraft(): Promise<void> {
    if (active === null || busy || !window.confirm(`丢弃 ${active.file.path} 的未保存修改吗？`)) return
    await discardDocument(active)
  }

  async function toggleEntry(entry: WorkspaceEntry): Promise<void> {
    const willExpand = !treeRef.current.expanded.has(entry.path)
    setTree(value => toggleDirectory(value, entry.path))
    if (willExpand) await loadDirectory(entry.path)
  }

  async function mutateEntry(method: 'POST' | 'PATCH' | 'DELETE', body: Record<string, unknown>, parent: string): Promise<void> {
    setBusy(true)
    try {
      await apiJson(await fetch(
        `${PAGECRAFT_WORKSPACE_ENTRY_PATH}?${apiQuery(sessionId)}`,
        { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selectedFolder, ...body }) },
      ))
      await loadDirectory(parent, true)
      setStatus('真实文件目录已更新。')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function createFile(kind: 'file' | 'directory'): Promise<void> {
    const parent = selectedEntry?.kind === 'directory'
      ? selectedEntry.path
      : selectedEntry?.path.includes('/') ? selectedEntry.path.slice(0, selectedEntry.path.lastIndexOf('/')) : selectedFolder
    const name = window.prompt(kind === 'file' ? '新文件名' : '新文件夹名')
    if (name === null || name.trim().length === 0) return
    await mutateEntry('POST', { parent, name, kind, content: name.endsWith('.json') ? '{}\n' : '' }, parent)
  }

  async function renameActive(): Promise<void> {
    if (selectedEntry === null || selectedEntry.path === selectedFolder) return
    if (active !== null && dirty && !window.confirm(`${active.file.path} 还有未保存修改。继续重命名会丢弃这些修改，确定吗？`)) return
    const nextName = window.prompt('新的名称', selectedEntry.name)
    if (nextName === null || nextName === selectedEntry.name) return
    const parent = selectedEntry.path.includes('/') ? selectedEntry.path.slice(0, selectedEntry.path.lastIndexOf('/')) : selectedFolder
    await mutateEntry('PATCH', { path: selectedEntry.path, nextName }, parent)
    setOpenFiles(items => items.filter(item => item.file.path !== selectedEntry.path))
    setActivePath(null)
    setSelectedEntry(null)
  }

  async function deleteActive(): Promise<void> {
    if (selectedEntry === null || selectedEntry.path === selectedFolder) return
    if (!window.confirm(`确定删除真实文件 ${selectedEntry.path} 吗？此操作会直接修改本地目录。`)) return
    const parent = selectedEntry.path.includes('/') ? selectedEntry.path.slice(0, selectedEntry.path.lastIndexOf('/')) : selectedFolder
    await mutateEntry('DELETE', { path: selectedEntry.path }, parent)
    setOpenFiles(items => items.filter(item => item.file.path !== selectedEntry.path))
    setActivePath(null)
    setSelectedEntry(null)
  }

  async function uploadImages(files: FileList | null): Promise<void> {
    if (files === null || files.length === 0) return
    const parent = selectedEntry?.kind === 'directory'
      ? selectedEntry.path
      : selectedEntry?.path.includes('/') ? selectedEntry.path.slice(0, selectedEntry.path.lastIndexOf('/')) : selectedFolder
    setBusy(true)
    try {
      for (const file of Array.from(files)) {
        const query = apiQuery(sessionId, { selectedFolder, parent, filename: file.name })
        await apiJson(await fetch(`${PAGECRAFT_WORKSPACE_BLOB_PATH}?${query}`, { method: 'POST', body: file }))
      }
      await loadDirectory(parent, true)
      setStatus(`已把 ${files.length} 张图片写入真实目录 ${parent}。`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      if (fileInputRef.current !== null) fileInputRef.current.value = ''
      setBusy(false)
    }
  }

  async function loadHistory(): Promise<void> {
    if (active === null) return
    const version = documentVersion(active)
    try {
      const query = apiQuery(sessionId, { selectedFolder, path: active.file.path })
      const entries = await apiJson<WorkspaceHistoryEntry[]>(await fetch(`${PAGECRAFT_WORKSPACE_HISTORY_PATH}?${query}`, { cache: 'no-store' }))
      if (!sameDocumentVersion(currentDocument(active), version)) return
      setHistoryDocumentId(active.documentId)
      setHistory(entries)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  async function restore(entry: WorkspaceHistoryEntry): Promise<void> {
    if (active === null || active.documentId !== historyDocumentId || busy || !window.confirm(`恢复 ${new Date(entry.createdAt).toLocaleString()} 的版本吗？`)) return
    const item = active
    const version = documentVersion(item)
    setBusy(true)
    try {
      const file = await apiJson<WorkspaceFile>(await fetch(
        `${PAGECRAFT_WORKSPACE_RESTORE_PATH}?${apiQuery(item.scope.sessionId)}`,
        { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ selectedFolder: item.scope.selectedFolder, path: item.file.path, historyId: entry.id, baseHash: item.file.hash }) },
      ))
      const current = currentDocument(item)
      if (!sameDocumentVersion(current, version, true)) return
      if (sameDocumentReplacementVersion(current, version)) {
        await discardDocument(current!, file)
        const afterCleanup = currentDocument(item)
        if (sameDocumentVersion(afterCleanup, version, true)) {
          // Disk restore already succeeded even when cleanup failed or new edits arrived.
          setOpenFiles(items => items.map(open => open.documentId === item.documentId ? { ...open, file } : open))
          const error = await persistDocument(currentDocument(item)!)
          setStatus(error === null ? '历史版本已写入磁盘；保留的修改仍未保存。' : `历史版本已写入磁盘，但草稿缓存失败：${error}`)
        }
      } else {
        setOpenFiles(items => items.map(open => open.documentId === item.documentId
          ? observeSourceConflict({ ...open, file }, open.conflictRevision === version.conflictRevision ? null : open.conflict)
          : open))
        const latest = currentDocument(item)!
        const error = await persistDocument(latest)
        setStatus(error === null ? '历史版本已写入磁盘；恢复期间的新修改已保留。' : `历史版本已写入磁盘，但新草稿缓存失败：${error}`)
      }
      setHistory([])
      window.setTimeout(onRefresh, 450)
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  async function browseFolders(path: string): Promise<void> {
    setFolderBrowsePath(path)
    try {
      const query = apiQuery(sessionId, { parent: path })
      setFolderEntries(await apiJson(await fetch(`${PAGECRAFT_WORKSPACE_FOLDERS_PATH}?${query}`, { cache: 'no-store' })))
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }

  async function openFolderPicker(): Promise<void> {
    setFolderPickerOpen(true)
    await browseFolders(selectedFolder)
  }

  async function chooseFolder(): Promise<void> {
    setFolderPickerOpen(false)
    setBusy(true)
    try {
      await connectFolder(folderBrowsePath, summary?.rootPath)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const refreshOpenFiles = useCallback(async (): Promise<void> => {
    for (const item of openFilesRef.current) {
      const version = documentVersion(item)
      const request = Symbol('refresh')
      refreshRequestsRef.current.set(item.documentId, request)
      try {
        const query = apiQuery(item.scope.sessionId, { selectedFolder: item.scope.selectedFolder, path: item.file.path })
        const disk = await apiJson<WorkspaceFile>(await fetch(`${PAGECRAFT_WORKSPACE_FILE_PATH}?${query}`, { cache: 'no-store' }))
        // Only the most recently requested read may update this document. An older
        // response must not advance conflictRevision and invalidate a newer read.
        if (refreshRequestsRef.current.get(item.documentId) !== request) continue
        setOpenFiles(files => files.map(open => {
          if (!sameDocumentReplacementVersion(open, version, true)) return open
          if (disk.hash === open.file.hash) {
            // Disk B returning to base A invalidates an obsolete replacement.
            // A legacy draft conflict already representing A remains unresolved.
            return open.conflict && open.conflict.hash !== disk.hash ? observeSourceConflict(open, null) : open
          }
          if (sourceDocumentDirty(open) || open.editRevision !== version.editRevision) {
            return observeSourceConflict(open, disk)
          }
          return resetSourceDocument(open, disk)
        }))
      } catch (error) {
        if (refreshRequestsRef.current.get(item.documentId) !== request) continue
        if (error instanceof WorkspaceApiError && error.status === 404) {
          setOpenFiles(files => files.filter(open => !sameDocumentVersion(open, version)))
        }
      } finally {
        if (refreshRequestsRef.current.get(item.documentId) === request) refreshRequestsRef.current.delete(item.documentId)
      }
    }
  }, [setOpenFiles])

  useEffect(() => {
    if (summary === null) return
    const query = apiQuery(sessionId, { selectedFolder })
    const events = new EventSource(`${PAGECRAFT_WORKSPACE_EVENTS_PATH}?${query}`)
    events.addEventListener('ready', (event) => {
      try {
        const value = JSON.parse((event as MessageEvent).data) as { sequence?: unknown }
        if (typeof value.sequence === 'number') lastSequenceRef.current = value.sequence
      } catch {
        lastSequenceRef.current = 0
      }
    })
    events.addEventListener('workspace', (event) => {
      try {
        const value = JSON.parse((event as MessageEvent).data) as WorkspaceEvent
        const paths = value.paths.map(path => {
          if (selectedFolder === '.') return path
          return path === '.' ? selectedFolder : `${selectedFolder}/${path}`
        })
        const normalized = { ...value, paths }
        const reduction = applyWorkspaceEvent(treeRef.current, lastSequenceRef.current, normalized)
        lastSequenceRef.current = reduction.lastSequence
        treeRef.current = reduction.tree
        setTree(reduction.tree)
        const refreshPaths = reduction.rescanRequired ? Array.from(reduction.tree.expanded) : paths
        for (const path of refreshPaths) {
          if (reduction.tree.expanded.has(path)) void loadDirectory(path, true)
        }
        void refreshOpenFiles()
      } catch {
        setStatus('文件同步事件格式异常，请点击刷新重新检查目录。')
      }
    })
    events.onerror = () => setStatus('自动同步暂时中断，可点击“刷新目录”重新检查文件。')
    return () => events.close()
  }, [loadDirectory, refreshOpenFiles, selectedFolder, sessionId, summary?.selectedPath])

  useEffect(() => {
    function reconcileOnFocus(): void {
      for (const path of treeRef.current.expanded) void loadDirectory(path, true)
      void refreshOpenFiles()
    }
    window.addEventListener('focus', reconcileOnFocus)
    return () => window.removeEventListener('focus', reconcileOnFocus)
  }, [loadDirectory, refreshOpenFiles])

  function beginResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (focus !== 'split' || shellRef.current === null) return
    const shell = shellRef.current
    function move(next: PointerEvent): void {
      const bounds = shell.getBoundingClientRect()
      const treeWidth = treeVisible ? 190 : 0
      const available = Math.max(1, bounds.width - treeWidth)
      setSplit(Math.min(75, Math.max(32, (next.clientX - bounds.left - treeWidth) / available * 100)))
    }
    function end(): void {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    event.preventDefault()
  }

  const mainColumns = focus === 'editor'
    ? 'minmax(0, 1fr) 0 0'
    : focus === 'preview'
      ? '0 0 minmax(0, 1fr)'
      : `minmax(260px, ${split}fr) 7px minmax(260px, ${100 - split}fr)`
  const rootEntry: WorkspaceEntry = {
    path: selectedFolder,
    name: selectedFolder === '.' ? (summary?.rootPath.split(/[\\/]/).at(-1) ?? '工作区') : (selectedFolder.split('/').at(-1) ?? selectedFolder),
    kind: 'directory',
    updatedAt: '',
    textEditable: false,
    imagePreviewable: false,
  }
  const conflictDocument = active?.conflict != null ? active : openFiles.find(item => item.conflict !== null)
  const conflict = conflictDocument?.conflict
  const canSave = active !== null && dirty && active.conflict === null && !sourceDocumentReadOnly(active)
  const currentEntry = selectedEntry ?? (activePath === null ? null : workspaceEntryByPath(tree, activePath))
  const imageSource = currentEntry?.imagePreviewable
    ? `${PAGECRAFT_WORKSPACE_BLOB_PATH}?${apiQuery(sessionId, { selectedFolder, path: currentEntry.path })}`
    : null

  return (
    <div ref={shellRef} data-pagecraft-source-workspace="" style={sourceStyles.root}>
      <header style={sourceStyles.toolbar}>
        <div style={sourceStyles.brand}><strong>PageCraft 文件工作区</strong><span title={summary?.selectedPath}>{selectedFolder} · 与本地目录实时同步</span></div>
        <button type="button" onClick={() => { void openFolderPicker() }} style={sourceStyles.toolbarButton}>打开文件夹</button>
        <button type="button" onClick={() => {
          for (const path of treeRef.current.expanded) void loadDirectory(path, true)
          void refreshOpenFiles()
        }} style={sourceStyles.toolbarButton}>刷新目录</button>
        <button type="button" onClick={() => setTreeVisible(value => !value)} style={{ ...sourceStyles.toolbarButton, ...(treeVisible ? sourceStyles.toolbarButtonActive : {}) }}>☰ 文件树</button>
        <button type="button" onClick={() => setFocus('split')} style={{ ...sourceStyles.toolbarButton, ...(focus === 'split' ? sourceStyles.toolbarButtonActive : {}) }}>分栏</button>
        <button type="button" onClick={() => setFocus('editor')} style={{ ...sourceStyles.toolbarButton, ...(focus === 'editor' ? sourceStyles.toolbarButtonActive : {}) }}>代码最大化</button>
        <button type="button" onClick={() => setFocus('preview')} style={{ ...sourceStyles.toolbarButton, ...(focus === 'preview' ? sourceStyles.toolbarButtonActive : {}) }}>预览最大化</button>
        <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={event => { void uploadImages(event.target.files) }} />
        <button type="button" onClick={() => fileInputRef.current?.click()} style={sourceStyles.toolbarButton}>上传图片</button>
        <button type="button" disabled={!canSave || busy} onClick={() => { void saveActive() }} style={{ ...sourceStyles.saveButton, ...(!canSave || busy ? sourceStyles.disabled : {}) }}>{busy ? '处理中…' : dirty ? '保存 Ctrl+S' : '已保存'}</button>
        <button type="button" aria-label="关闭文件工作区" onClick={handleClose} style={sourceStyles.closeButton}>×</button>
      </header>

      <div style={{ ...sourceStyles.body, gridTemplateColumns: treeVisible ? '190px minmax(0, 1fr)' : '0 minmax(0, 1fr)' }}>
        <aside style={sourceStyles.treePane}>
          <div style={sourceStyles.treeActions}>
            <button type="button" title="新建文件" onClick={() => { void createFile('file') }} style={sourceStyles.tinyButton}>＋文件</button>
            <button type="button" title="新建目录" onClick={() => { void createFile('directory') }} style={sourceStyles.tinyButton}>＋目录</button>
          </div>
          <div style={sourceStyles.treeScroller}>
            <TreeNode entry={rootEntry} depth={0} activePath={activePath} tree={tree} onOpen={(node) => { void openEntry(node) }} onToggle={(node) => { void toggleEntry(node) }} />
          </div>
          <div style={sourceStyles.fileActions}>
            <button type="button" disabled={selectedEntry === null || selectedEntry.path === selectedFolder} onClick={() => { void renameActive() }} style={sourceStyles.tinyButton}>重命名</button>
            <button type="button" disabled={selectedEntry === null || selectedEntry.path === selectedFolder} onClick={() => { void deleteActive() }} style={sourceStyles.dangerTinyButton}>删除</button>
          </div>
        </aside>

        <main style={{ ...sourceStyles.main, gridTemplateColumns: mainColumns }}>
          <section style={sourceStyles.editorPane}>
            <div style={sourceStyles.tabs}>
              {openFiles.map(item => (
                <button key={item.file.path} type="button" onClick={() => {
                  setActivePath(item.file.path)
                  setSelectedEntry(workspaceEntryByPath(tree, item.file.path))
                }} style={{ ...sourceStyles.tab, ...(activePath === item.file.path ? sourceStyles.tabActive : {}) }}>
                  <span>{item.file.path.split('/').at(-1)}</span>{sourceDocumentDirty(item) ? <b>●</b> : null}
                  <span role="button" aria-label={`关闭 ${item.file.path}`} onClick={(event) => { event.stopPropagation(); closeTab(item.file.path) }} style={sourceStyles.tabClose}>×</span>
                </button>
              ))}
            </div>
            <div style={sourceStyles.editorBody}>
              {active !== null ? (
                <CodeEditor
                  documentId={active.documentId}
                  resetRevision={active.resetRevision}
                  readOnly={sourceDocumentReadOnly(active)}
                  path={active.file.path}
                  value={active.draft}
                  revealLine={revealLocation?.path === active.file.path ? revealLocation.line : undefined}
                  onChange={updateDraft}
                  onSave={() => { void saveActive() }}
                />
              ) : imageSource !== null ? (
                <div style={sourceStyles.imagePreview}><img src={imageSource} alt={currentEntry?.name ?? '项目图片'} style={sourceStyles.imagePreviewContent} /></div>
              ) : currentEntry !== null ? (
                <div style={sourceStyles.binaryInfo}><strong>{currentEntry.name}</strong><span>{currentEntry.path}</span><span>{currentEntry.bytes === undefined ? '文件夹' : `${Math.ceil(currentEntry.bytes / 1024)} KB`}</span><span>此文件不作为文本打开。</span></div>
              ) : <div style={sourceStyles.noFile}>从左侧选择真实项目文件</div>}
            </div>
            <footer style={sourceStyles.editorStatus}>
              <span>{active !== null && sourceDocumentReadOnly(active) ? '此文件只读：不自动统一混合换行。' : status}</span>
              <div style={sourceStyles.statusActions}>
                {active !== null ? <button type="button" onClick={() => { void loadHistory() }} style={sourceStyles.statusButton}>历史版本</button> : null}
                {dirty ? <button type="button" disabled={busy} onClick={() => { void discardActiveDraft() }} style={sourceStyles.statusButton}>丢弃修改</button> : null}
                <span>{active?.file.language ?? ''}{dirty ? ' · 未保存' : active === null ? '' : ' · 已保存'}</span>
              </div>
            </footer>
          </section>

          <div onPointerDown={beginResize} style={sourceStyles.divider}>⋮</div>

          <section style={sourceStyles.previewPane}>
            <div style={sourceStyles.previewHeader}>
              <strong>实时预览</strong>
              <div style={sourceStyles.previewActions}>
                <button type="button" disabled={previewSrc === null} onClick={() => choosePreviewMode('text')} style={{ ...sourceStyles.statusButton, ...(previewSelectionMode === 'text' ? sourceStyles.textModeButtonActive : {}) }}>选择文字</button>
                <button type="button" disabled={previewSrc === null} onClick={() => choosePreviewMode('element')} style={{ ...sourceStyles.statusButton, ...(previewSelectionMode === 'element' ? sourceStyles.toolbarButtonActive : {}) }}>选择元素</button>
                <button type="button" disabled={previewSrc === null} onClick={() => choosePreviewMode('area')} style={{ ...sourceStyles.statusButton, ...(previewSelectionMode === 'area' ? sourceStyles.areaModeButtonActive : {}) }}>框选区域</button>
                <button type="button" disabled={previewSrc === null} onClick={onRefresh} style={sourceStyles.statusButton}>刷新</button>
              </div>
            </div>
            {previewSrc === null ? <div data-pagecraft-workspace-empty-preview="" style={sourceStyles.emptyPreview}>尚未设置预览地址；可继续浏览和编辑项目文件。</div> : <iframe
              ref={previewRef}
              title="PageCraft 文件实时预览"
              src={previewSrc}
              sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
              style={sourceStyles.previewFrame}
              onLoad={() => postPreviewMode(previewSelectionMode)}
            />}
            {textSelection !== null ? (
              <div style={sourceStyles.textEditPanel}>
                <div style={sourceStyles.textEditHeader}>
                  <div><strong>直接修改显示文字</strong><span>{textSelection.tagName} · {textSelection.displayedText.slice(0, 80)}</span></div>
                  <button type="button" onClick={() => {
                    previewRef.current?.contentWindow?.postMessage({
                      type: 'dsh-pagecraft-convert-text-selection',
                      selection: textSelection,
                    }, '*')
                  }} style={sourceStyles.secondaryTextButton}>转为评注</button>
                </div>
                <textarea
                  autoFocus
                  value={replacementText}
                  disabled={textEditBusy}
                  onChange={event => setReplacementText(event.target.value)}
                  placeholder="输入页面上要显示的新文字"
                  style={sourceStyles.textEditInput}
                />
                <div style={sourceStyles.textEditActions}>
                  <span>只会在找到唯一、安全的本地源码位置时写入；失败会自动恢复。</span>
                  <button type="button" disabled={textEditBusy} onClick={() => {
                    setTextSelection(null)
                    setReplacementText('')
                  }} style={sourceStyles.secondaryTextButton}>取消</button>
                  <button
                    type="button"
                    disabled={textEditBusy || replacementText === textSelection.displayedText}
                    onClick={() => { void startDirectTextEdit() }}
                    style={{ ...sourceStyles.primaryButton, ...(textEditBusy || replacementText === textSelection.displayedText ? sourceStyles.disabled : {}) }}
                  >{textEditBusy ? '验证中…' : '修改文字'}</button>
                </div>
              </div>
            ) : null}
          </section>
        </main>
      </div>

      {history.length > 0 && active?.documentId === historyDocumentId ? (
        <div style={sourceStyles.historyPanel}>
          <div style={sourceStyles.historyHeader}><strong>最近保存版本</strong><button type="button" onClick={() => setHistory([])} style={sourceStyles.statusButton}>关闭</button></div>
          {history.map(entry => (
            <button key={entry.id} type="button" onClick={() => { void restore(entry) }} style={sourceStyles.historyItem}>
              <span>{new Date(entry.createdAt).toLocaleString()}</span><code>{entry.hash.slice(0, 8)}</code><span>{Math.ceil(entry.bytes / 1024)} KB</span>
            </button>
          ))}
        </div>
      ) : null}

      {conflict != null && conflictDocument !== undefined ? (
        <div style={sourceStyles.conflictOverlay}>
          <div style={sourceStyles.conflictDialog}>
            <strong style={sourceStyles.conflictTitle}>文件已被 Agent 或其他编辑器修改：{conflictDocument.file.path}</strong>
            <p style={sourceStyles.conflictText}>为避免覆盖最新代码，PageCraft 已停止保存。可以载入磁盘版本，或者明确用你的内容覆盖当前版本。</p>
            <div style={sourceStyles.diffGrid}>
              <div><b>我的版本</b><pre>{sourceDocumentRaw(conflictDocument).slice(0, 3000)}</pre></div>
              <div><b>磁盘最新版本</b><pre>{conflict.content.slice(0, 3000)}</pre></div>
            </div>
            <div style={sourceStyles.conflictActions}>
              <button type="button" onClick={() => {
                if (busy) return
                void discardDocument(conflictDocument, conflict)
              }} style={sourceStyles.secondaryButton}>载入最新版本</button>
              <button type="button" disabled={busy || sourceDocumentReadOnly(conflictDocument)} onClick={() => {
                if (busy) return
                void writeFile(conflictDocument, conflict.hash)
              }} style={sourceStyles.dangerButton}>用我的版本覆盖</button>
            </div>
          </div>
        </div>
      ) : null}

      {folderPickerOpen ? (
        <div style={sourceStyles.conflictOverlay}>
          <div style={sourceStyles.folderDialog}>
            <strong style={sourceStyles.conflictTitle}>选择当前 DSH 工作区中的文件夹</strong>
            <code style={sourceStyles.folderPath}>{folderBrowsePath}</code>
            <div style={sourceStyles.folderList}>
              {folderBrowsePath !== '.' ? <button type="button" onClick={() => {
                const parent = folderBrowsePath.includes('/') ? folderBrowsePath.slice(0, folderBrowsePath.lastIndexOf('/')) : '.'
                void browseFolders(parent)
              }} style={sourceStyles.folderItem}>↩ 上一级</button> : null}
              {folderEntries.map(entry => <button key={entry.path} type="button" onDoubleClick={() => { void browseFolders(entry.path) }} onClick={() => { void browseFolders(entry.path) }} style={sourceStyles.folderItem}>▸ {entry.name}</button>)}
            </div>
            <div style={sourceStyles.conflictActions}>
              <button type="button" onClick={() => setFolderPickerOpen(false)} style={sourceStyles.secondaryButton}>取消</button>
              <button type="button" onClick={() => { void chooseFolder() }} style={sourceStyles.primaryButton}>打开当前文件夹</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

const sourceStyles: Record<string, CSSProperties> = {
  root: { position: 'absolute', inset: 0, zIndex: 30, minHeight: 0, display: 'flex', flexDirection: 'column', color: '#eaf2ec', background: '#0d1210' },
  toolbar: { minHeight: 48, display: 'flex', alignItems: 'center', gap: 7, padding: '0 12px', borderBottom: '1px solid #2c3d34', background: '#141b17' },
  brand: { minWidth: 190, marginRight: 'auto', display: 'grid', gap: 2, fontSize: 12 },
  toolbarButton: { height: 31, padding: '0 10px', border: '1px solid #34473d', borderRadius: 7, color: '#cbd8d0', background: '#1b2620', cursor: 'pointer', fontSize: 11 },
  toolbarButtonActive: { color: '#102016', borderColor: '#88c99a', background: '#a9e2b7', fontWeight: 800 },
  saveButton: { height: 32, padding: '0 12px', border: '1px solid #88c99a', borderRadius: 7, color: '#102016', background: '#a9e2b7', cursor: 'pointer', fontWeight: 800, fontSize: 11 },
  disabled: { opacity: .45, cursor: 'not-allowed' },
  closeButton: { width: 32, height: 32, border: '1px solid #463936', borderRadius: 7, color: '#eee', background: '#2a211f', cursor: 'pointer', fontSize: 20 },
  body: { flex: 1, minHeight: 0, display: 'grid', overflow: 'hidden', transition: 'grid-template-columns .18s ease' },
  treePane: { minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', borderRight: '1px solid #2c3d34', background: '#111815' },
  treeActions: { width: 190, display: 'flex', gap: 5, padding: 8, boxSizing: 'border-box', borderBottom: '1px solid #26352d' },
  treeScroller: { width: 190, flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 5px', boxSizing: 'border-box' },
  treeItem: { width: '100%', height: 27, display: 'flex', alignItems: 'center', gap: 5, border: 0, borderRadius: 5, color: '#b9c7be', background: 'transparent', cursor: 'pointer', textAlign: 'left', fontSize: 11 },
  treeItemActive: { color: '#fff', background: '#293b31' },
  treeIcon: { width: 13, color: '#86a291' },
  treeName: { minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  lock: { color: '#d7b56d', fontSize: 6 },
  fileActions: { width: 190, display: 'flex', gap: 5, padding: 8, boxSizing: 'border-box', borderTop: '1px solid #26352d' },
  tinyButton: { minHeight: 26, padding: '0 7px', border: '1px solid #34473d', borderRadius: 6, color: '#aebdb4', background: '#18221d', cursor: 'pointer', fontSize: 10 },
  dangerTinyButton: { minHeight: 26, padding: '0 7px', border: '1px solid #5b3735', borderRadius: 6, color: '#e7aaa6', background: '#271716', cursor: 'pointer', fontSize: 10 },
  main: { minWidth: 0, minHeight: 0, display: 'grid', overflow: 'hidden' },
  editorPane: { minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: '#0b100e' },
  tabs: { minHeight: 33, display: 'flex', overflowX: 'auto', borderBottom: '1px solid #29372f', background: '#151d19' },
  tab: { flex: 'none', height: 33, display: 'flex', alignItems: 'center', gap: 7, padding: '0 9px', border: 0, borderRight: '1px solid #29372f', color: '#9eaea4', background: 'transparent', cursor: 'pointer', fontSize: 10 },
  tabActive: { color: '#fff', borderTop: '2px solid #88c99a', background: '#0b100e' },
  tabClose: { color: '#829087', fontSize: 14 },
  editorBody: { flex: 1, minHeight: 0, overflow: 'hidden' },
  codeEditor: { width: '100%', height: '100%', overflow: 'hidden' },
  noFile: { height: '100%', display: 'grid', placeItems: 'center', color: '#65756c', fontSize: 12 },
  imagePreview: { width: '100%', height: '100%', display: 'grid', placeItems: 'center', overflow: 'auto', padding: 20, boxSizing: 'border-box', background: '#171d1a' },
  imagePreviewContent: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 6, boxShadow: '0 10px 34px rgba(0,0,0,.35)' },
  binaryInfo: { height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 20, color: '#93a49a', textAlign: 'center', fontSize: 12 },
  editorStatus: { minHeight: 28, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '0 9px', borderTop: '1px solid #29372f', color: '#84958b', background: '#151d19', fontSize: 10 },
  statusActions: { display: 'flex', alignItems: 'center', gap: 8 },
  statusButton: { padding: '3px 7px', border: '1px solid #34473d', borderRadius: 5, color: '#a9b8af', background: '#1a241f', cursor: 'pointer', fontSize: 10 },
  divider: { display: 'grid', placeItems: 'center', overflow: 'hidden', color: '#71877a', background: '#1f2d25', cursor: 'col-resize', userSelect: 'none' },
  previewPane: { minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: '#dce3df' },
  previewHeader: { height: 33, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 9px', color: '#d9e5dd', background: '#151d19', fontSize: 11 },
  previewActions: { display: 'flex', alignItems: 'center', gap: 5 },
  textModeButtonActive: { color: '#0c1b12', borderColor: '#8bd0a0', background: '#a9e2b7', fontWeight: 800 },
  areaModeButtonActive: { color: '#25170a', borderColor: '#e0a76f', background: '#f2c28f', fontWeight: 800 },
  previewFrame: { flex: 1, width: '100%', minHeight: 0, border: 0, background: '#fff' },
  emptyPreview: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, color: '#6e7d74', textAlign: 'center' },
  textEditPanel: { flex: 'none', display: 'grid', gap: 8, padding: 10, borderTop: '1px solid #34473d', color: '#dce8e0', background: '#111915' },
  textEditHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11 },
  textEditInput: { width: '100%', minHeight: 72, resize: 'vertical', boxSizing: 'border-box', padding: 9, border: '1px solid #3b5547', borderRadius: 7, color: '#eff7f1', background: '#0a100d', font: '12px/1.5 ui-sans-serif, system-ui, sans-serif' },
  textEditActions: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 7, color: '#899b90', fontSize: 10 },
  secondaryTextButton: { height: 29, padding: '0 9px', border: '1px solid #405449', borderRadius: 6, color: '#c4d0c8', background: '#1a241f', cursor: 'pointer', fontSize: 10 },
  primaryButton: { height: 34, padding: '0 13px', border: '1px solid #88c99a', borderRadius: 7, color: '#102016', background: '#a9e2b7', cursor: 'pointer', fontWeight: 800 },
  secondaryButton: { height: 34, padding: '0 13px', border: '1px solid #3b4d43', borderRadius: 7, color: '#cbd8d0', background: '#1a241f', cursor: 'pointer' },
  dangerButton: { height: 34, padding: '0 13px', border: '1px solid #a85c56', borderRadius: 7, color: '#ffd2cf', background: '#512521', cursor: 'pointer', fontWeight: 800 },
  historyPanel: { position: 'absolute', right: 16, top: 60, zIndex: 35, width: 330, maxHeight: 420, overflowY: 'auto', padding: 10, border: '1px solid #3a4d42', borderRadius: 10, background: '#141d18', boxShadow: '0 16px 50px rgba(0,0,0,.4)' },
  historyHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 3px 9px' },
  historyItem: { width: '100%', display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 8, padding: '8px 7px', border: 0, borderTop: '1px solid #29382f', color: '#bdc9c1', background: 'transparent', cursor: 'pointer', textAlign: 'left', fontSize: 10 },
  conflictOverlay: { position: 'absolute', inset: 0, zIndex: 50, display: 'grid', placeItems: 'center', padding: 24, background: 'rgba(4,7,5,.78)', backdropFilter: 'blur(5px)' },
  conflictDialog: { width: 'min(900px, 96vw)', maxHeight: '86vh', overflowY: 'auto', padding: 20, border: '1px solid #674842', borderRadius: 12, background: '#191b18', boxShadow: '0 24px 80px rgba(0,0,0,.55)' },
  folderDialog: { width: 'min(560px, 92vw)', maxHeight: '78vh', display: 'flex', flexDirection: 'column', gap: 12, padding: 20, border: '1px solid #466354', borderRadius: 12, background: '#151d19', boxShadow: '0 24px 80px rgba(0,0,0,.55)' },
  folderPath: { padding: 9, border: '1px solid #30443a', borderRadius: 7, color: '#b9c9bf', background: '#0d1411', overflowWrap: 'anywhere', fontSize: 11 },
  folderList: { minHeight: 160, maxHeight: 420, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 3 },
  folderItem: { minHeight: 32, padding: '0 10px', border: '1px solid transparent', borderRadius: 6, color: '#c4d0c8', background: '#1c2821', cursor: 'pointer', textAlign: 'left' },
  conflictTitle: { display: 'block', color: '#ffd1cc', fontSize: 17 },
  conflictText: { color: '#b9c4bc', fontSize: 12, lineHeight: 1.6 },
  diffGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
  conflictActions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 },
}
