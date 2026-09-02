import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import yaml from 'js-yaml'
import {
  composeProfileEntries,
  healProfilesModuleFallback,
  loadProfile,
  resolveAgentHome,
} from './profile.js'
import type { EntryOptions, LoadedProfile } from './types.js'

export type BuiltinPluginMap = Readonly<Record<string, unknown>>

export interface PluginHostOptions {
  entries: readonly EntryOptions[]
  baseUrl: string
  builtins?: BuiltinPluginMap
}

export interface StartProfileOptions {
  home?: string
  installAnchor?: string
  builtins?: BuiltinPluginMap
}

export interface PluginHost {
  ctx: Context
  profile?: LoadedProfile
  dispose(): Promise<void>
}

export interface PreparedProfile {
  profile: LoadedProfile
  entries: EntryOptions[]
  yaml: string
}

export const INSTALL_ANCHOR = fileURLToPath(new URL('../../package.json', import.meta.url))

const standardBuiltins: Record<string, unknown> = Object.create(null)
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  ACTIVE: 2 as FiberState.ACTIVE,
} as const

export function registerHostBuiltin(name: string, plugin: unknown): () => void {
  const key = builtinKey(name)
  if (standardBuiltins[key] !== undefined) {
    throw new Error(`ai-agent: duplicate host builtin ${JSON.stringify(name)}`)
  }
  standardBuiltins[key] = plugin
  return () => {
    if (standardBuiltins[key] === plugin) delete standardBuiltins[key]
  }
}

export async function bootPluginHost(options: PluginHostOptions): Promise<PluginHost> {
  const ctx = new Context()
  let disposed = false
  try {
    await ctx.plugin(Loader, { baseUrl: options.baseUrl })
    const builtins = { ...standardBuiltins, ...(options.builtins ?? {}) }
    for (const [name, plugin] of Object.entries(builtins)) {
      ctx.loader.builtins[builtinKey(name)] = plugin
    }
    await ctx.loader.root.update(structuredClone(options.entries) as EntryOptions[])
    await ctx.loader.await()
    assertEntriesActivated(ctx)
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
  return {
    ctx,
    async dispose() {
      if (disposed) return
      disposed = true
      await ctx.fiber.dispose()
    },
  }
}

export function prepareAiAgentProfile(
  name: string,
  options: Pick<StartProfileOptions, 'home' | 'installAnchor'> = {},
): PreparedProfile {
  const home = options.home ?? resolveAgentHome()
  const installAnchor = options.installAnchor ?? INSTALL_ANCHOR
  healProfilesModuleFallback(installAnchor, home)
  const profile = loadProfile(name, installAnchor, home)
  const entries = composeProfileEntries(profile)
  const rendered = yaml.dump(entries, { schema: entryListSchema, noRefs: true, lineWidth: 120 })
  writeFileSync(join(profile.dir, 'cordis.yml'), rendered)
  return { profile, entries, yaml: rendered }
}

export async function startAiAgentProfile(
  name: string,
  options: StartProfileOptions = {},
): Promise<PluginHost> {
  const prepared = prepareAiAgentProfile(name, options)
  const host = await bootPluginHost({
    entries: prepared.entries,
    baseUrl: pathToFileURL(join(prepared.profile.dir, 'package.json')).href,
    builtins: options.builtins,
  })
  return { ...host, profile: prepared.profile }
}

function assertEntriesActivated(ctx: Context): void {
  const pending: string[] = []
  for (const entry of ctx.loader.entries()) {
    const fiber = entry.fiber
    if (entry.disabled || fiber === undefined) continue
    if (fiber.state === FIBER_STATE.ACTIVE) continue
    if (fiber.state === FIBER_STATE.PENDING) {
      const services = Object.keys(fiber.inject)
      pending.push(`${entry.id} (${entry.options.name}) waiting for ${services.join(', ') || 'an unavailable service'}`)
      continue
    }
    throw new Error(
      `ai-agent: plugin ${entry.id} (${entry.options.name}) did not activate; Cordis fiber state ${fiber.state}`,
    )
  }
  if (pending.length > 0) {
    throw new Error(`ai-agent: plugin activation has unsatisfied injections:\n${pending.join('\n')}`)
  }
}

function builtinKey(name: string): string {
  return name.startsWith('cordis:') ? name.slice('cordis:'.length) : name
}
