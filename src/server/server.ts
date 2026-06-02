import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { URL } from 'node:url'
import {
  abortSession,
  createSession,
  getOrchestrator,
  isSessionRunning,
  listSessions,
  loadSession,
  markSessionIdle,
  markSessionRunning,
  updateAllowedPaths,
} from './sessionApi.js'
import { startJsonStream, writeStreamEvent } from './stream.js'
import { assertPreviewUrl, buildPreviewHtml } from './preview.js'
import { listDirectories, pickDirectory } from './fileBrowser.js'
import { loadMetricsFromStateDir } from './metrics.js'
import { loadAppConfig } from '../config/appConfig.js'

const { serverPort: port } = loadAppConfig()
const stateDir = 'state'

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
  })
  res.end(JSON.stringify(payload))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
  }
  if (!raw.trim()) return {}
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as Record<string, unknown>
}

function getSessionId(pathname: string, suffix = ''): string | null {
  const match = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/.*)?$/)
  if (!match) return null
  if (suffix && !pathname.endsWith(suffix)) return null
  return decodeURIComponent(match[1])
}

async function handleStream(sessionId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (isSessionRunning(sessionId)) {
    sendJson(res, 409, { error: '当前会话已有任务正在运行' })
    return
  }

  let body: Record<string, unknown>
  try {
    body = await readJson(req)
  } catch {
    sendJson(res, 400, { error: '请求内容不是有效 JSON' })
    return
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) {
    sendJson(res, 400, { error: 'prompt 不能为空' })
    return
  }

  const orchestrator = await getOrchestrator(sessionId)
  markSessionRunning(sessionId)
  startJsonStream(res)
  writeStreamEvent(res, { type: 'start', sessionId })

  try {
    await orchestrator.handleUserInput(prompt, async (event) => {
      writeStreamEvent(res, event)
    })
    writeStreamEvent(res, { type: 'done', sessionId })
  } catch (err) {
    writeStreamEvent(res, {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
  } finally {
    markSessionIdle(sessionId)
    res.end()
  }
}

async function handlePreview(url: URL, res: ServerResponse): Promise<void> {
  const rawTarget = url.searchParams.get('url') || ''
  if (!rawTarget) {
    sendJson(res, 400, { error: 'url 不能为空' })
    return
  }

  let target: URL
  try {
    target = assertPreviewUrl(rawTarget)
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
    return
  }

  const upstream = await fetch(target)
  const contentType = upstream.headers.get('content-type') || ''
  if (!upstream.ok) {
    sendJson(res, upstream.status, { error: `预览页面请求失败：HTTP ${upstream.status}` })
    return
  }
  if (!contentType.includes('text/html')) {
    sendJson(res, 415, { error: '预览代理第一版只支持 HTML 页面' })
    return
  }

  const html = await upstream.text()
  res.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
    'Content-Type': 'text/html; charset=utf-8',
  })
  res.end(buildPreviewHtml(html, target.toString()))
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method || 'GET'
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const { pathname } = url

  if (method === 'OPTIONS') {
    sendJson(res, 204, {})
    return
  }

  try {
    if (method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { ok: true })
      return
    }

    if (method === 'GET' && pathname === '/api/preview') {
      await handlePreview(url, res)
      return
    }

    if (method === 'GET' && pathname === '/api/filesystem/directories') {
      sendJson(res, 200, await listDirectories(url.searchParams.get('path') || undefined, {
        roots: url.searchParams.get('roots') === '1',
      }))
      return
    }

    if (method === 'POST' && pathname === '/api/filesystem/pick-directory') {
      const body = await readJson(req)
      const initialPath = typeof body.initialPath === 'string' ? body.initialPath : undefined
      sendJson(res, 200, await pickDirectory(initialPath))
      return
    }

    if (method === 'GET' && pathname === '/api/sessions') {
      sendJson(res, 200, { sessions: await listSessions() })
      return
    }

    if (method === 'POST' && pathname === '/api/sessions') {
      const sessionId = await createSession()
      sendJson(res, 201, { sessionId })
      return
    }

    const sessionId = getSessionId(pathname)
    if (sessionId && method === 'GET' && pathname === `/api/sessions/${encodeURIComponent(sessionId)}`) {
      sendJson(res, 200, await loadSession(sessionId))
      return
    }

    if (sessionId && method === 'GET' && pathname.endsWith('/metrics')) {
      sendJson(res, 200, await loadMetricsFromStateDir(stateDir, sessionId))
      return
    }

    if (sessionId && method === 'POST' && pathname.endsWith('/paths')) {
      const body = await readJson(req)
      const allowedPaths = Array.isArray(body.allowedPaths)
        ? body.allowedPaths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : []
      sendJson(res, 200, await updateAllowedPaths(sessionId, allowedPaths))
      return
    }

    if (sessionId && method === 'POST' && pathname.endsWith('/abort')) {
      await abortSession(sessionId)
      sendJson(res, 200, { ok: true })
      return
    }

    if (sessionId && method === 'POST' && pathname.endsWith('/stream')) {
      await handleStream(sessionId, req, res)
      return
    }

    sendJson(res, 404, { error: 'Not found' })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

const server = createServer((req, res) => {
  void handleRequest(req, res)
})

server.listen(port, () => {
  console.log(`Agent web server listening on http://localhost:${port}`)
})
