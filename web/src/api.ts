export type SessionSummary = {
  id: string
  title?: string
  updatedAt: number
}

export type Message = {
  uuid: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  createdAt: number
  isMeta?: boolean
  isCompressed?: boolean
}

export type MemoryRecallMode = 'auto' | 'off' | 'on'

export type MemorySettings = {
  recallMode: MemoryRecallMode
}

export type RepositoryConfig = {
  repoUrl?: string
  prRepoUrl?: string
  upstreamUrl?: string
  defaultBaseBranch?: string
  githubLogin?: string
  gitUserName?: string
  gitUserEmail?: string
}

export type RepositoryIdentity = {
  rootDir: string
  githubLogin?: string
  gitUserName?: string
  gitUserEmail?: string
}

export type MemoryLayerId = 'session' | 'project' | 'global'
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export type MemoryItem = {
  id: string
  name: string
  description: string
  type: MemoryType
  layer: MemoryLayerId
  content: string
  filePath: string
}

export type WorldState = {
  sessionId: string
  allowedPaths: string[]
  memorySettings?: MemorySettings
  repository?: RepositoryConfig
  pendingConfirm?: { allowWrite: boolean; message: string }
  goal?: string
}

export type SessionDetail = {
  id: string
  title?: string
  running: boolean
  state: WorldState
  messages: Message[]
}

export type StreamEvent =
  | { type: 'start'; sessionId: string }
  | { type: 'output'; message: string }
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; name: string; arguments: string }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'result'; result: unknown }
  | { type: 'aborted'; message: string }
  | { type: 'done'; sessionId: string }
  | { type: 'error'; message: string }

export type DirectoryEntry = {
  name: string
  path: string
}

export type DirectoryListing = {
  path: string
  parentPath: string | null
  entries: DirectoryEntry[]
  isRootListing?: boolean
  canListRoots?: boolean
}

export type MetricsCall = {
  timestamp: number
  promptTokens: number
  completionTokens: number
  latencyMs: number
  firstTokenMs: number
}

export type MetricsSummary = {
  callCount: number
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  averageLatencyMs: number
  averageFirstTokenMs: number
}

export type SessionMetrics = {
  sessionId: string
  startedAt: number | null
  calls: MetricsCall[]
  summary: MetricsSummary
}

export type SessionMemory = {
  settings: MemorySettings
  projectInfo: {
    key: string
    displayName: string
    rootDir: string
    remoteUrl?: string
  }
  layers: Array<{
    id: MemoryLayerId
    label: string
    scope: string
    paths: {
      directory: string
      index: string
    }
    items: MemoryItem[]
  }>
}

export type ManagedSkill = {
  id: string
  name: string
  description: string
  trigger?: string
  summary?: string
  node?: string
  entry?: string
  enabled: boolean
  source: 'builtin' | 'custom'
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  const payload = await res.json()
  if (!res.ok) {
    const message = typeof payload?.error === 'string' ? payload.error : `HTTP ${res.status}`
    throw new Error(message)
  }
  return payload as T
}

export async function listSessions(): Promise<SessionSummary[]> {
  const payload = await jsonRequest<{ sessions: SessionSummary[] }>('/api/sessions')
  return payload.sessions
}

export async function createSession(): Promise<string> {
  const payload = await jsonRequest<{ sessionId: string }>('/api/sessions', { method: 'POST' })
  return payload.sessionId
}

export async function loadSession(sessionId: string): Promise<SessionDetail> {
  return jsonRequest<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}`)
}

export async function updateSessionTitle(sessionId: string, title: string): Promise<SessionDetail> {
  return jsonRequest<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}/title`, {
    method: 'POST',
    body: JSON.stringify({ title }),
  })
}

export async function loadSessionMetrics(sessionId: string): Promise<SessionMetrics> {
  return jsonRequest<SessionMetrics>(`/api/sessions/${encodeURIComponent(sessionId)}/metrics`)
}

export async function updateAllowedPaths(sessionId: string, allowedPaths: string[]): Promise<SessionDetail> {
  return jsonRequest<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}/paths`, {
    method: 'POST',
    body: JSON.stringify({ allowedPaths }),
  })
}

export async function loadSessionMemory(sessionId: string): Promise<SessionMemory> {
  return jsonRequest<SessionMemory>(`/api/sessions/${encodeURIComponent(sessionId)}/memory`)
}

export async function updateMemorySettings(sessionId: string, recallMode: MemoryRecallMode): Promise<SessionDetail> {
  return jsonRequest<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}/memory-settings`, {
    method: 'POST',
    body: JSON.stringify({ recallMode }),
  })
}

export async function updateRepositoryConfig(sessionId: string, repository: RepositoryConfig): Promise<SessionDetail> {
  return jsonRequest<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}/repository`, {
    method: 'POST',
    body: JSON.stringify({ repository }),
  })
}

export async function loadRepositoryIdentity(sessionId: string): Promise<RepositoryIdentity> {
  return jsonRequest<RepositoryIdentity>(`/api/sessions/${encodeURIComponent(sessionId)}/repository/identity`)
}

export async function clearPendingConfirm(sessionId: string): Promise<SessionDetail> {
  return jsonRequest<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}/pending-confirm`, {
    method: 'DELETE',
  })
}

export async function saveMemoryItem(
  sessionId: string,
  input: { layer: MemoryLayerId; name?: string; description?: string; type?: MemoryType; body: string },
): Promise<{ memoryState: SessionMemory }> {
  return jsonRequest<{ memoryState: SessionMemory }>(`/api/sessions/${encodeURIComponent(sessionId)}/memory/items`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function deleteMemoryItem(sessionId: string, name: string): Promise<{ deleted: boolean; memoryState: SessionMemory }> {
  return jsonRequest<{ deleted: boolean; memoryState: SessionMemory }>(`/api/sessions/${encodeURIComponent(sessionId)}/memory/items/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
}

export async function revealMemoryItem(sessionId: string, layer: MemoryLayerId, name: string): Promise<{ ok: boolean; filePath: string }> {
  return jsonRequest<{ ok: boolean; filePath: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/memory/items/${encodeURIComponent(name)}/reveal`, {
    method: 'POST',
    body: JSON.stringify({ layer }),
  })
}

export async function listSkills(): Promise<ManagedSkill[]> {
  const payload = await jsonRequest<{ skills: ManagedSkill[] }>('/api/skills')
  return payload.skills
}

export async function uploadSkill(fileName: string, content: string): Promise<{ skill: ManagedSkill }> {
  return jsonRequest<{ skill: ManagedSkill }>('/api/skills/upload', {
    method: 'POST',
    body: JSON.stringify({ fileName, content }),
  })
}

export async function updateSkillEnabled(id: string, enabled: boolean): Promise<{ skill: ManagedSkill }> {
  return jsonRequest<{ skill: ManagedSkill }>(`/api/skills/${encodeURIComponent(id)}/enabled`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  })
}

export async function deleteSkill(id: string): Promise<{ deleted: boolean }> {
  return jsonRequest<{ deleted: boolean }>(`/api/skills/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export async function abortSession(sessionId: string): Promise<void> {
  await jsonRequest<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: 'POST' })
}

export async function deleteSession(sessionId: string): Promise<void> {
  await jsonRequest<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
}

export async function downloadSessionExport(sessionId: string): Promise<{ blob: Blob; fileName?: string }> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/export`)
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const payload = await res.json()
      if (typeof payload?.error === 'string') message = payload.error
    } catch {}
    throw new Error(message)
  }

  const contentDisposition = res.headers.get('content-disposition') || ''
  const fileNameMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)
  return {
    blob: await res.blob(),
    fileName: fileNameMatch ? decodeURIComponent(fileNameMatch[1]) : undefined,
  }
}

export async function listDirectories(path?: string, options: { roots?: boolean } = {}): Promise<DirectoryListing> {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  if (options.roots) params.set('roots', '1')
  const query = params.toString() ? `?${params.toString()}` : ''
  return jsonRequest<DirectoryListing>(`/api/filesystem/directories${query}`)
}

export async function pickDirectory(initialPath?: string): Promise<{ path: string | null }> {
  return jsonRequest<{ path: string | null }>('/api/filesystem/pick-directory', {
    method: 'POST',
    body: JSON.stringify({ initialPath }),
  })
}

export async function streamPrompt(
  sessionId: string,
  prompt: string,
  onEvent: (event: StreamEvent) => void,
  onAccepted?: () => void,
): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })

  if (!res.ok || !res.body) {
    let message = `HTTP ${res.status}`
    try {
      const payload = await res.json()
      if (typeof payload?.error === 'string') message = payload.error
    } catch {}
    throw new Error(message)
  }
  onAccepted?.()

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    while (true) {
      const idx = buffer.indexOf('\n')
      if (idx === -1) break
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      onEvent(JSON.parse(line) as StreamEvent)
    }
  }
}

export const consumePromptStream = streamPrompt
