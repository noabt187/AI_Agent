import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import type { FiberState } from '@deepseek-ai/cordis'
import type { DshClientManifest, ProfileManifest } from './types.js'
import { resolvePackageDir } from './profile.js'

export interface ActiveLoaderEntry {
  options: { name: string }
  disabled: boolean
  fiber?: { state: FiberState }
}

export interface ClientManifestRow {
  id: string
  url: string
  rev: string
  inject?: string[]
  immediately?: boolean
}

export interface ClientManifest {
  revision: string
  modules: ClientManifestRow[]
}

export interface ClientArtifact {
  pluginId: string
  path: string
  contentType: 'text/javascript' | 'application/json'
  rev: string
}

interface ClientRecord {
  row: ClientManifestRow
  script: ClientArtifact
  sourceMap?: ClientArtifact
}

interface PluginPackageManifest extends ProfileManifest {
  exports?: unknown
}

const ACTIVE_FIBER = 2 as FiberState.ACTIVE

declare module '@deepseek-ai/cordis' {
  interface Context {
    clientModules: ClientModuleRegistry
  }
}

export class ClientModuleRegistry extends Service {
  static inject = ['loader', 'webServer']
  private records = new Map<string, ClientRecord>()
  private currentManifest: ClientManifest = { revision: hash('[]'), modules: [] }
  private readonly profileAnchor: string

  constructor(ctx: Context) {
    super(ctx, 'clientModules')
    this.profileAnchor = contextAnchor(ctx.baseUrl)
  }

  [Service.init](): void {
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'exact',
      path: '/api/plugins/client-manifest',
      handler: (_req, res) => {
        this.refreshFromLoader()
        writeJson(res, 200, this.currentManifest)
      },
    }), 'plugin client manifest')
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'prefix',
      path: '/plugins',
      handler: (req, res) => this.serve(req, res),
    }), 'plugin client artifacts')
  }

  refresh(entries: readonly ActiveLoaderEntry[]): void {
    const next = new Map<string, ClientRecord>()
    for (const entry of entries) {
      if (entry.disabled || entry.fiber?.state !== ACTIVE_FIBER || entry.options.name.startsWith('cordis:')) continue
      const record = this.readClientRecord(entry.options.name)
      if (record === undefined) continue
      if (next.has(record.row.id)) {
        throw new Error(`ai-agent: duplicate dsh.client module id ${JSON.stringify(record.row.id)}`)
      }
      next.set(record.row.id, record)
    }
    const modules = [...next.values()].map(record => record.row)
    this.records = next
    this.currentManifest = { revision: hash(JSON.stringify(modules)), modules }
  }

  refreshFromLoader(): void {
    this.refresh([...this.ctx.loader.entries()])
  }

  manifest(): ClientManifest {
    this.refreshFromLoader()
    return structuredClone(this.currentManifest)
  }

  resolveArtifact(pathname: string): ClientArtifact | undefined {
    for (const record of this.records.values()) {
      const base = `/plugins/${encodeURIComponent(record.row.id)}`
      if (pathname === `${base}/client.js`) return record.script
      if (pathname === `${base}/client.js.map`) return record.sourceMap
    }
    return undefined
  }

  async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' })
      res.end()
      return
    }
    this.refreshFromLoader()
    const url = new URL(req.url ?? '/', 'http://localhost')
    const artifact = this.resolveArtifact(url.pathname)
    if (artifact === undefined) {
      writeJson(res, 404, { error: 'Plugin artifact not found' })
      return
    }
    const immutable = url.searchParams.get('rev') === artifact.rev
    res.writeHead(200, {
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Content-Type': `${artifact.contentType}; charset=utf-8`,
    })
    res.end(req.method === 'HEAD' ? undefined : readFileSync(artifact.path))
  }

  private readClientRecord(packageName: string): ClientRecord | undefined {
    const packageDir = resolvePackageDir(packageName, this.profileAnchor)
    if (packageDir === undefined) return undefined
    const manifest = readManifest(resolve(packageDir, 'package.json'))
    const client = manifest.dsh?.client
    if (client === undefined) return undefined
    validateClientManifest(packageName, client)
    if (client.platform !== 'web') return undefined
    const clientPath = resolveClientExport(packageName, packageDir, manifest)
    const revision = hash(readFileSync(clientPath)).slice(0, 12)
    const id = manifest.name || packageName
    const encodedId = encodeURIComponent(id)
    const row: ClientManifestRow = {
      id,
      url: `/plugins/${encodedId}/client.js?rev=${revision}`,
      rev: revision,
      ...(client.inject === undefined ? {} : { inject: [...client.inject] }),
      ...(client.immediately === undefined ? {} : { immediately: client.immediately }),
    }
    const script: ClientArtifact = {
      pluginId: id,
      path: clientPath,
      contentType: 'text/javascript',
      rev: revision,
    }
    const sourceMapPath = `${clientPath}.map`
    const sourceMap: ClientArtifact | undefined = existsSync(sourceMapPath)
      ? { pluginId: id, path: sourceMapPath, contentType: 'application/json', rev: revision }
      : undefined
    return { row, script, sourceMap }
  }
}

function contextAnchor(baseUrl: string | undefined): string {
  if (!baseUrl) return resolve(process.cwd(), 'package.json')
  if (baseUrl.startsWith('file:')) return fileURLToPath(baseUrl)
  return baseUrl
}

function readManifest(path: string): PluginPackageManifest {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`ai-agent: invalid plugin package manifest ${path}`)
  }
  return parsed as PluginPackageManifest
}

function validateClientManifest(packageName: string, client: DshClientManifest): void {
  if (typeof client.platform !== 'string' || client.platform === '') {
    throw new Error(`ai-agent: plugin ${packageName} has invalid dsh.client.platform`)
  }
  if (client.inject !== undefined && (!Array.isArray(client.inject) || client.inject.some(name => typeof name !== 'string'))) {
    throw new Error(`ai-agent: plugin ${packageName} has invalid dsh.client.inject`)
  }
  if (client.immediately !== undefined && typeof client.immediately !== 'boolean') {
    throw new Error(`ai-agent: plugin ${packageName} has invalid dsh.client.immediately`)
  }
}

function resolveClientExport(packageName: string, packageDir: string, manifest: PluginPackageManifest): string {
  const exportsField = manifest.exports
  const clientExport = exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)
    ? (exportsField as Record<string, unknown>)['./client']
    : undefined
  const declared = typeof clientExport === 'string'
    ? clientExport
    : clientExport && typeof clientExport === 'object' && !Array.isArray(clientExport)
      ? (clientExport as Record<string, unknown>).default
      : undefined
  if (typeof declared !== 'string' || declared === '') {
    throw new Error(`ai-agent: plugin ${packageName} declares dsh.client but exports no usable ./client bundle`)
  }
  const path = resolve(packageDir, declared)
  const rel = relative(packageDir, path)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !existsSync(path)) {
    throw new Error(`ai-agent: plugin ${packageName} has an invalid or missing ./client bundle at ${path}`)
  }
  return path
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export const clientModulesPlugin = ClientModuleRegistry
export default ClientModuleRegistry
