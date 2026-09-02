import type { IncomingMessage, ServerResponse } from 'node:http'
import { URL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  abortSession,
  addMemoryItem,
  clearPendingConfirm,
  createSession,
  deleteSession,
  getOrchestrator,
  isSessionRunning,
  listSessions,
  loadRepositoryIdentity,
  loadSessionExport,
  loadSessionMemory,
  loadSession,
  markSessionIdle,
  markSessionRunning,
  removeMemoryItem,
  revealMemoryItem,
  updateAllowedPaths,
  updateSessionTitle,
  updateMemorySettings,
  updateRepositoryConfig,
} from './sessionApi.js'
import { startJsonStream, writeStreamEvent } from './stream.js'
import { assertPreviewUrl, buildPreviewHtml } from './preview.js'
import { listDirectories, pickDirectory } from './fileBrowser.js'
import { loadMetricsFromStateDir } from './metrics.js'
import {
  deleteManagedSkill,
  listManagedSkills,
  setManagedSkillEnabled,
  SkillRegistryError,
  uploadManagedSkill,
} from '../skills/registry.js'
import { getSessionId, HttpError, readJson, sendJson } from './http.js'

const stateDir = 'state'

export const coreRoutesPlugin = {
  name: 'ai-agent-core-routes',
  inject: ['webServer'],
  apply(ctx: Context) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: '/api', handler: handleCoreRequest }),
      'ai-agent core API',
    )
  },
}

export async function handleCoreRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          'Content-Type': 'application/json; charset=utf-8',
        })
        res.end(JSON.stringify({ exportedAt: Date.now(), session: sessionExport, metrics }, null, 2))
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          sendJson(res, 404, { error: '会话不存在' })
          return
        }
        throw error
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

    if (sessionId && method === 'GET' && pathname.endsWith('/repository/identity')) {
      sendJson(res, 200, await loadRepositoryIdentity(sessionId))
      return
    }

    if (sessionId && method === 'DELETE' && pathname.endsWith('/pending-confirm')) {
      sendJson(res, 200, await clearPendingConfirm(sessionId))
      return
    }

    if (sessionId && method === 'POST' && pathname.endsWith('/memory/items')) {
      sendJson(res, 200, await addMemoryItem(sessionId, await readJson(req)))
      return
    }

    const memoryDeleteMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/memory\/items\/([^/]+)$/)
    if (sessionId && memoryDeleteMatch && method === 'DELETE') {
      sendJson(res, 200, await removeMemoryItem(sessionId, decodeURIComponent(memoryDeleteMatch[2])))
      return
    }

    const memoryRevealMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/memory\/items\/([^/]+)\/reveal$/)
    if (sessionId && memoryRevealMatch && method === 'POST') {
      const body = await readJson(req)
      sendJson(res, 200, await revealMemoryItem(sessionId, body.layer, decodeURIComponent(memoryRevealMatch[2])))
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
  } catch (error) {
    sendJson(res, errorStatus(error), { error: error instanceof Error ? error.message : String(error) })
  }
}

function buildDownloadFileName(sessionId: string, title?: string): string {
  const baseName = (title?.trim() || sessionId).replace(/[\\/:*?"<>|]+/g, '-').trim() || sessionId
  return `${baseName}.json`
}

function errorStatus(error: unknown): number {
  if (error instanceof HttpError || error instanceof SkillRegistryError) return error.statusCode
  return 500
}

async function handleStream(sessionId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (isSessionRunning(sessionId)) {
    sendJson(res, 409, { error: '当前会话已有任务正在运行' })
    return
  }
  const body = await readJson(req)
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
    await orchestrator.handleUserInput(prompt, async event => { writeStreamEvent(res, event) })
    writeStreamEvent(res, { type: 'done', sessionId })
  } catch (error) {
    writeStreamEvent(res, {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
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
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
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
  res.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
    'Content-Type': 'text/html; charset=utf-8',
  })
  res.end(buildPreviewHtml(await upstream.text(), target.toString()))
}

export default coreRoutesPlugin
