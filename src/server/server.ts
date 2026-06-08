import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { URL } from 'node:url'
import {
  abortSession,
  addPinnedMemory,
  createSession,
  deleteSession,
  getOrchestrator,
  isSessionRunning,
  listSessions,
  loadSessionExport,
  loadSessionMemory,
  loadSession,
  markSessionIdle,
  markSessionRunning,
  removePinnedMemory,
  updateAllowedPaths,
  updateSessionTitle,
  updateMemorySettings,
  updateRepositoryConfig,
} from './sessionApi.js'
import { startJsonStream, writeStreamEvent } from './stream.js'
import { assertPreviewUrl, buildPreviewHtml } from './preview.js'
import { listDirectories, pickDirectory } from './fileBrowser.js'
import { loadMetricsFromStateDir } from './metrics.js'
import { loadAppConfig } from '../config/appConfig.js'
import {
  deleteManagedSkill,
  listManagedSkills,
  setManagedSkillEnabled,
  SkillRegistryError,
  uploadManagedSkill,
} from '../skills/registry.js'

const { serverPort: port } = loadAppConfig()
const stateDir = 'state'

function buildDownloadFileName(sessionId: string, title?: string): string {
  const baseName = (title?.trim() || sessionId).replace(/[\\/:*?"<>|]+/g, '-').trim() || sessionId
  return `${baseName}.json`
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
  })
  res.end(JSON.stringify(payload))
}

function errorStatus(err: unknown): number {
  if (err instanceof SkillRegistryError) return err.statusCode
  return 500
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

    if (method === 'GET' && pathname === '/api/skills') {
      sendJson(res, 200, { skills: await listManagedSkills() })
      return
    }

    if (method === 'POST' && pathname === '/api/skills/upload') {
      const body = await readJson(req)
      const fileName = typeof body.fileName === 'string' ? body.fileName : ''
      const content = typeof body.content === 'string' ? body.content : ''
      sendJson(res, 201, { skill: await uploadManagedSkill({ fileName, content }) })
      return
    }

    const skillEnableMatch = pathname.match(/^\/api\/skills\/([^/]+)\/enabled$/)
    if (method === 'POST' && skillEnableMatch) {
      const body = await readJson(req)
      if (typeof body.enabled !== 'boolean') throw new SkillRegistryError('enabled 必须是 boolean')
      const skillId = decodeURIComponent(skillEnableMatch[1])
      sendJson(res, 200, { skill: await setManagedSkillEnabled(skillId, body.enabled) })
      return
    }

    const skillDeleteMatch = pathname.match(/^\/api\/skills\/([^/]+)$/)
    if (method === 'DELETE' && skillDeleteMatch) {
      const skillId = decodeURIComponent(skillDeleteMatch[1])
      sendJson(res, 200, await deleteManagedSkill(skillId))
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

    if (sessionId && method === 'GET' && pathname.endsWith('/export')) {
      try {
        const [sessionExport, metrics] = await Promise.all([
          loadSessionExport(sessionId),
          loadMetricsFromStateDir(stateDir, sessionId),
        ])
        const fileName = buildDownloadFileName(sessionExport.id, sessionExport.title)
        const payload = {
          exportedAt: Date.now(),
          session: sessionExport,
          metrics,
        }
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          'Content-Type': 'application/json; charset=utf-8',
        })
        res.end(JSON.stringify(payload, null, 2))
      } catch (err) {
        if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
          sendJson(res, 404, { error: '会话不存在' })
          return
        }
        throw err
      }
      return
    }

    if (sessionId && method === 'GET' && pathname.endsWith('/memory')) {
      sendJson(res, 200, await loadSessionMemory(sessionId))
      return
    }

    if (sessionId && method === 'POST' && pathname.endsWith('/memory-settings')) {
      const body = await readJson(req)
      sendJson(res, 200, await updateMemorySettings(sessionId, body.recallMode))
      return
    }

    if (sessionId && method === 'POST' && pathname.endsWith('/repository')) {
      const body = await readJson(req)
      sendJson(res, 200, await updateRepositoryConfig(sessionId, body.repository ?? body))
      return
    }

    if (sessionId && method === 'POST' && pathname.endsWith('/memory/pinned')) {
      const body = await readJson(req)
      sendJson(res, 200, await addPinnedMemory(sessionId, body.content))
      return
    }

    const pinnedDeleteMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/memory\/pinned\/([^/]+)$/)
    if (sessionId && pinnedDeleteMatch && method === 'DELETE') {
      sendJson(res, 200, await removePinnedMemory(sessionId, decodeURIComponent(pinnedDeleteMatch[2])))
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

    if (sessionId && method === 'POST' && pathname.endsWith('/title')) {
      const body = await readJson(req)
      const title = typeof body.title === 'string' ? body.title : ''
      sendJson(res, 200, await updateSessionTitle(sessionId, title))
      return
    }

    if (sessionId && method === 'POST' && pathname.endsWith('/abort')) {
      await abortSession(sessionId)
      sendJson(res, 200, { ok: true })
      return
    }

    if (sessionId && method === 'DELETE' && pathname === `/api/sessions/${encodeURIComponent(sessionId)}`) {
      await deleteSession(sessionId)
      sendJson(res, 200, { ok: true })
      return
    }

    if (sessionId && method === 'POST' && pathname.endsWith('/stream')) {
      await handleStream(sessionId, req, res)
      return
    }

    sendJson(res, 404, { error: 'Not found' })
  } catch (err) {
    sendJson(res, errorStatus(err), { error: err instanceof Error ? err.message : String(err) })
  }
}

const server = createServer((req, res) => {
  void handleRequest(req, res)
})

server.listen(port, () => {
  console.log(`Agent web server listening on http://localhost:${port}`)
})
