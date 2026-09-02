import type { ServerResponse } from 'node:http'

export function startJsonStream(res: ServerResponse): void {
  res.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Content-Type': 'application/x-ndjson; charset=utf-8',
  })
  res.flushHeaders()
}

export function writeStreamEvent(res: ServerResponse, event: unknown): void {
  res.write(`${JSON.stringify(event)}\n`)
}
