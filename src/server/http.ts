import type { IncomingMessage, ServerResponse } from 'node:http'

export class HttpError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message)
  }
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
  })
  res.end(status === 204 ? undefined : JSON.stringify(payload))
}

export async function readJson(
  req: IncomingMessage,
  maxBytes = 1024 * 1024,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > maxBytes) throw new HttpError(`请求内容超过 ${maxBytes} 字节限制`, 413)
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new HttpError('请求内容不是有效 JSON', 400)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as Record<string, unknown>
}

export function getSessionId(pathname: string, suffix = ''): string | null {
  const match = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/.*)?$/)
  if (!match || (suffix && !pathname.endsWith(suffix))) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    throw new HttpError('sessionId 编码无效', 400)
  }
}
