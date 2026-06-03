import { existsSync, readFileSync } from 'node:fs'
import { dirname, parse, resolve } from 'node:path'

type AppConfig = {
  serverPort: number
  webPort: number
}

const defaultConfig: AppConfig = {
  serverPort: 3001,
  webPort: 5173,
}

type RawAppConfig = Partial<{
  serverPort: unknown
  webPort: unknown
}>

function findConfigPath(startDir = process.cwd()): string | null {
  let current = resolve(startDir)
  const { root } = parse(current)

  while (true) {
    const candidate = resolve(current, 'config', 'app.json')
    if (existsSync(candidate)) return candidate
    if (current === root) return null
    current = dirname(current)
  }
}

function parsePort(value: unknown, fallback: number): number {
  const port = typeof value === 'string' ? Number(value) : value
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return fallback
  return port
}

function readAppConfig(startDir?: string): RawAppConfig {
  const configPath = findConfigPath(startDir)
  if (!configPath) return {}

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as RawAppConfig
  } catch {
    return {}
  }
}

export function loadAppConfig(startDir?: string): AppConfig {
  const fileConfig = readAppConfig(startDir)
  const serverPort = parsePort(
    process.env.AGENT_SERVER_PORT ?? process.env.PORT ?? fileConfig.serverPort,
    defaultConfig.serverPort,
  )
  const webPort = parsePort(process.env.AGENT_WEB_PORT ?? fileConfig.webPort, defaultConfig.webPort)

  return { serverPort, webPort }
}
