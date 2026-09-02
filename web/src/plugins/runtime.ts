import { Context, type Plugin } from '@deepseek-ai/cordis'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as jsxRuntime from 'react/jsx-runtime'
import { ClientModuleSystem, type ClientModuleSystemOptions } from './clientModuleSystem'
import BrowserSessionService from './sessions'
import BrowserSlotService from './slots'
import type { ClientManifest } from './types'

export interface BrowserPluginRuntime {
  ctx: Context
  modules: ClientModuleSystem
  slots: BrowserSlotService
  sessions: BrowserSessionService
  dispose(): Promise<void>
}

export interface BrowserPluginRuntimeOptions {
  manifest?: ClientManifest
  fetchManifest?: () => Promise<ClientManifest>
  loadBundle?: ClientModuleSystemOptions['loadBundle']
  seeds?: Readonly<Record<string, unknown>>
}

const platformDependencyIds = new Set([
  'slots',
  'sessions',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-conversation',
])

export async function bootBrowserPluginRuntime(
  options: BrowserPluginRuntimeOptions = {},
): Promise<BrowserPluginRuntime> {
  const manifest = options.manifest ?? await (options.fetchManifest ?? fetchClientManifest)()
  validateManifestDependencies(manifest)
  const modules = new ClientModuleSystem({
    modules: manifest.modules,
    seeds: {
      react: React,
      'react/jsx-runtime': jsxRuntime,
      'react-dom': ReactDOM,
      'react-dom/client': ReactDOMClient,
      ...(options.seeds ?? {}),
    },
    loadBundle: options.loadBundle,
  })
  const ctx = new Context()
  let disposed = false
  try {
    await ctx.plugin(BrowserSlotService)
    await ctx.plugin(BrowserSessionService)
    ctx.slots.declare('conversation.input.left', { kind: 'list', scope: 'session' })
    ctx.slots.declare('conversation.input.right', { kind: 'list', scope: 'session' })
    ctx.slots.declare('conversation.input.dock', { kind: 'list', scope: 'session' })
    ctx.slots.declare('conversation.input.overlay', { kind: 'list', scope: 'session' })

    const fibers = []
    for (const row of manifest.modules) {
      if (row.immediately) await modules.prefetch(row.id)
      const plugin = await modules.import(row.id)
      if (typeof plugin.apply !== 'function') {
        throw new Error(`browser-plugins: client module "${row.id}" exports no Cordis apply function`)
      }
      fibers.push(ctx.plugin(plugin as unknown as Plugin))
    }
    await Promise.all(fibers.map(fiber => fiber.await()))
  } catch (error) {
    modules.dispose()
    await ctx.fiber.dispose()
    throw error
  }
  return {
    ctx,
    modules,
    slots: ctx.slots,
    sessions: ctx.sessions,
    async dispose() {
      if (disposed) return
      disposed = true
      modules.dispose()
      await ctx.fiber.dispose()
    },
  }
}

export async function fetchClientManifest(): Promise<ClientManifest> {
  const response = await fetch('/api/plugins/client-manifest')
  if (!response.ok) throw new Error(`Plugin manifest request failed: ${response.status}`)
  return response.json() as Promise<ClientManifest>
}

function validateManifestDependencies(manifest: ClientManifest): void {
  const ids = new Set(manifest.modules.map(row => row.id))
  for (const row of manifest.modules) {
    for (const dependency of row.inject ?? []) {
      if (!ids.has(dependency) && !platformDependencyIds.has(dependency)) {
        throw new Error(`browser-plugins: "${row.id}" depends on missing client module "${dependency}"`)
      }
    }
  }
}
