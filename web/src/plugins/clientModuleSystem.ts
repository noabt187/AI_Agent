import type {
  ClientManifestRow,
  ClientPluginHandoff,
} from './types'

interface ClientModuleRecord {
  id: string
  exports: Record<string, unknown>
  styles: HTMLStyleElement[]
  edges: Set<string>
}

export interface ClientModuleSystemOptions {
  modules: readonly ClientManifestRow[]
  seeds: Readonly<Record<string, unknown>>
  loadBundle?: (url: string) => Promise<void>
}

const stripClientSuffix = (specifier: string): string =>
  specifier.endsWith('/client') ? specifier.slice(0, -'/client'.length) : specifier

const defaultLoadBundle = (url: string): Promise<void> => new Promise((resolve, reject) => {
  if (typeof document === 'undefined') {
    reject(new Error(`client-modules: cannot load ${url} without a browser document`))
    return
  }
  const script = document.createElement('script')
  script.async = true
  script.src = url
  script.addEventListener('load', () => {
    script.remove()
    resolve()
  }, { once: true })
  script.addEventListener('error', () => {
    script.remove()
    reject(new Error(`client-modules: bundle script ${url} failed to load`))
  }, { once: true })
  document.head.append(script)
})

export class ClientModuleSystem {
  readonly version = 'client' as const
  readonly loadCache = new Map<string, ClientModuleRecord>()

  private readonly rows = new Map<string, ClientManifestRow>()
  private readonly seeds: Map<string, unknown>
  private readonly factories = new Map<string, ClientPluginHandoff['factory']>()
  private readonly pending = new Map<string, Promise<void>>()
  private readonly materializing = new Set<string>()
  private readonly loadBundle: (url: string) => Promise<void>
  private readonly target: typeof globalThis & { __ModuleLoader__?: Window['__ModuleLoader__'] }

  constructor(options: ClientModuleSystemOptions) {
    this.seeds = new Map(Object.entries(options.seeds))
    this.loadBundle = options.loadBundle ?? defaultLoadBundle
    for (const row of options.modules) {
      if (this.rows.has(row.id)) throw new Error(`client-modules: duplicate graph entry "${row.id}"`)
      this.rows.set(row.id, { ...row })
    }

    this.target = globalThis as typeof this.target
    if (this.target.__ModuleLoader__ !== undefined) {
      throw new Error('client-modules: window.__ModuleLoader__ already installed (double boot?)')
    }
    this.target.__ModuleLoader__ = {
      load: this.registerSink,
    }
  }

  async import(specifier: string): Promise<Record<string, unknown>> {
    if (this.seeds.has(specifier)) return this.seeds.get(specifier) as Record<string, unknown>
    const id = stripClientSuffix(specifier)
    const cached = this.loadCache.get(id)
    if (cached !== undefined) return cached.exports
    if (!this.factories.has(id)) {
      const row = this.rows.get(id)
      if (row === undefined) {
        throw new Error(`client-modules: cannot resolve "${specifier}" — no platform seed or client manifest row`)
      }
      await this.arrive(row)
    }
    return this.materialize(id).exports
  }

  async prefetch(id: string): Promise<void> {
    const normalized = stripClientSuffix(id)
    if (this.seeds.has(id) || this.factories.has(normalized)) return
    const row = this.rows.get(normalized)
    if (row === undefined) throw new Error(`client-modules: prefetch("${id}") — not a client manifest row`)
    await this.arrive(row)
  }

  invalidate(id: string): void {
    const normalized = stripClientSuffix(id)
    this.factories.delete(normalized)
    const record = this.loadCache.get(normalized)
    this.loadCache.delete(normalized)
    for (const style of record?.styles ?? []) style.remove()
  }

  dispose(): void {
    if (this.target.__ModuleLoader__?.load === this.registerSink) delete this.target.__ModuleLoader__
    for (const id of [...this.loadCache.keys()]) this.invalidate(id)
  }

  private readonly registerSink = (handoff: ClientPluginHandoff): void => this.register(handoff)

  private register(handoff: ClientPluginHandoff): void {
    if (!handoff || typeof handoff.id !== 'string' || typeof handoff.factory !== 'function') {
      throw new Error('client-modules: invalid __ModuleLoader__.load handoff')
    }
    if (!this.rows.has(handoff.id)) {
      throw new Error(`client-modules: bundle registered "${handoff.id}" without a client manifest row`)
    }
    if (this.factories.has(handoff.id)) {
      throw new Error(`client-modules: duplicate factory registration for "${handoff.id}"`)
    }
    this.factories.set(handoff.id, handoff.factory)
  }

  private arrive(row: ClientManifestRow): Promise<void> {
    const existing = this.pending.get(row.id)
    if (existing !== undefined) return existing
    if (this.factories.has(row.id)) return Promise.resolve()
    const task = this.loadBundle(row.url).then(() => {
      if (!this.factories.has(row.id)) {
        throw new Error(`client-modules: bundle ${row.url} loaded without registering "${row.id}"`)
      }
    }).finally(() => this.pending.delete(row.id))
    this.pending.set(row.id, task)
    return task
  }

  private materialize(id: string): ClientModuleRecord {
    const cached = this.loadCache.get(id)
    if (cached !== undefined) return cached
    const factory = this.factories.get(id)
    if (factory === undefined) throw new Error(`client-modules: no registered factory for "${id}"`)
    if (this.materializing.has(id)) {
      throw new Error(`client-modules: require cycle through "${id}"`)
    }
    this.materializing.add(id)
    try {
      const edges = new Set<string>()
      const before = currentStyles()
      const exports = factory(this.makeRequire(id, edges))
      if (exports === null || typeof exports !== 'object') {
        throw new Error(`client-modules: factory "${id}" did not return an exports object`)
      }
      const styles = claimNewStyles(id, before)
      const record = { id, exports, styles, edges }
      this.loadCache.set(id, record)
      return record
    } finally {
      this.materializing.delete(id)
    }
  }

  private makeRequire(ownerId: string, edges: Set<string>): (specifier: string) => unknown {
    return (specifier: string): unknown => {
      edges.add(specifier)
      if (this.seeds.has(specifier)) return this.seeds.get(specifier)
      const id = stripClientSuffix(specifier)
      const cached = this.loadCache.get(id)
      if (cached !== undefined) return cached.exports
      if (this.factories.has(id)) return this.materialize(id).exports
      throw new Error(
        `client-modules: plugin "${ownerId}" require("${specifier}") missed the platform seeds and registered factories`,
      )
    }
  }
}

function currentStyles(): Set<HTMLStyleElement> {
  if (typeof document === 'undefined') return new Set()
  return new Set(document.querySelectorAll('style'))
}

function claimNewStyles(id: string, before: ReadonlySet<HTMLStyleElement>): HTMLStyleElement[] {
  if (typeof document === 'undefined') return []
  const owned: HTMLStyleElement[] = []
  for (const style of document.querySelectorAll('style')) {
    if (before.has(style)) continue
    if (!style.dataset.plugin) style.dataset.plugin = id
    if (style.dataset.plugin === id) owned.push(style)
  }
  return owned
}
