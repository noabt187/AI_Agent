export type SessionSummary = {
  id: string
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

export type WorldState = {
  sessionId: string
  allowedPaths: string[]
  pendingConfirm?: { type: 'requirement' | 'design'; message: string }
  goal?: string
}

export type SessionDetail = {
  id: string
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

export async function loadSessionMetrics(sessionId: string): Promise<SessionMetrics> {
  return jsonRequest<SessionMetrics>(`/api/sessions/${encodeURIComponent(sessionId)}/metrics`)
}

export async function updateAllowedPaths(sessionId: string, allowedPaths: string[]): Promise<SessionDetail> {
  return jsonRequest<SessionDetail>(`/api/sessions/${encodeURIComponent(sessionId)}/paths`, {
    method: 'POST',
    body: JSON.stringify({ allowedPaths }),
  })
}

export async function abortSession(sessionId: string): Promise<void> {
  await jsonRequest<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: 'POST' })
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
