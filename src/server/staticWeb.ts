import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

export interface StaticWebConfig {
  root?: string
}

export const staticWebPlugin = {
  name: 'ai-agent-static-web',
  inject: ['webServer'],
  apply(ctx: Context, config: StaticWebConfig = {}) {
    const root = resolve(config.root ?? resolve(process.cwd(), 'web', 'dist'))
    ctx.effect(
      () => ctx.webServer.registerFallback((req, res) => serveStaticRequest(root, req, res)),
      'ai-agent static web fallback',
    )
  },
}

export async function serveStaticRequest(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' })
    res.end()
    return
  }
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    res.writeHead(400)
    res.end('Bad request')
    return
  }
  const requested = resolve(root, `.${decoded}`)
  const candidate = inside(root, requested) && isFile(requested)
    ? requested
    : resolve(root, 'index.html')
  if (!inside(root, candidate) || !isFile(candidate)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not found')
    return
  }
  res.writeHead(200, {
    'Cache-Control': candidate.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
    'Content-Type': contentType(candidate),
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  await new Promise<void>((resolveStream, reject) => {
    const stream = createReadStream(candidate)
    stream.once('error', reject)
    res.once('finish', resolveStream)
    stream.pipe(res)
  })
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    default: return 'application/octet-stream'
  }
}

export default staticWebPlugin
