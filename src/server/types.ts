import type { IncomingMessage, ServerResponse } from 'node:http'

export type RouteContext = {
  req: IncomingMessage
  res: ServerResponse
  pathname: string
  method: string
}

export type JsonRecord = Record<string, unknown>
