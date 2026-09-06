import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_PROFILE_BUNDLES,
  PROFILE_TEMPLATES,
  initProfile,
  readProfileManifest,
  resolveAgentHome,
  resolvePackageDir,
  resolveProfileDir,
  writeProfileManifest,
} from './profile.js'
import type { ProfileManifest } from './types.js'

export interface PluginInventory {
  name: string
  specifier: string
  version?: string
  bundle: boolean
  client: boolean
  active: boolean
}

export interface PluginCommandOptions {
  cwd?: string
  home?: string
  installAnchor?: string
  run?: (command: string, args: readonly string[], cwd: string) => number
  stdout?: Pick<NodeJS.WriteStream, 'write'>
  stderr?: Pick<NodeJS.WriteStream, 'write'>
}

const DEFAULT_INSTALL_ANCHOR = fileURLToPath(new URL('../../package.json', import.meta.url))

export function anchorPathSpec(argument: string, cwd: string): string {
  const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(argument)
  if (match?.groups?.path === undefined) return argument
  return `${match.groups.prefix ?? ''}${resolve(cwd, match.groups.path)}`
}

export function reconcileProfilePlugins(
  before: ProfileManifest,
  profileDir: string,
  installAnchor: string,
  stderr: Pick<NodeJS.WriteStream, 'write'> = process.stderr,
): PluginInventory[] {
  const after = readProfileManifest(profileDir)
  const beforeDependencies = new Set(Object.keys(before.dependencies ?? {}))
  const dependencies = Object.entries(after.dependencies ?? {})
  const bundles = [...(after.dsh?.profile?.bundles ?? [])]

  const inventory = dependencies.map(([name, specifier]): PluginInventory => {
    const packageDir = resolvePackageDir(name, join(profileDir, 'package.json'), installAnchor)
    const packageManifest = packageDir === undefined
      ? undefined
      : readPackageManifest(join(packageDir, 'package.json'))
    const bundle = typeof packageManifest?.dsh?.bundle?.patch === 'string'
    const client = packageManifest?.dsh?.client?.platform === 'web'
    if (bundle && !bundles.includes(name)) bundles.push(name)
    if (!bundle && !beforeDependencies.has(name)) {
      stderr.write(
        `ai-agent: warning: ${name} declares no dsh.bundle — installed as a plain dependency, not a profile layer\n`,
      )
    }
    return {
      name,
      specifier,
      version: packageManifest?.version,
      bundle,
      client,
      active: bundle ? bundles.includes(name) : false,
    }
  })

  const dependencyNames = new Set(dependencies.map(([name]) => name))
  for (const name of [...bundles]) {
    const managed = beforeDependencies.has(name) || dependencyNames.has(name)
    if (!managed) continue
    const row = inventory.find(item => item.name === name)
    if (row?.bundle === true) continue
    bundles.splice(bundles.indexOf(name), 1)
  }

  if (!sameStrings(bundles, after.dsh?.profile?.bundles ?? [])) {
    after.dsh = {
      ...after.dsh,
      profile: { ...after.dsh?.profile, bundles },
    }
    writeProfileManifest(profileDir, after)
  }
  return inventory
}

export function runPluginCommand(
  profile: string,
  args: readonly string[],
  options: PluginCommandOptions = {},
): number {
  if (args.length === 0) {
    ;(options.stderr ?? process.stderr).write('ai-agent: plugin needs pnpm arguments to forward\n')
    return 2
  }
  const home = options.home ?? resolveAgentHome()
  const profileDir = resolveProfileDir(profile, home)
  if (!existsSync(join(profileDir, 'package.json'))) {
    initProfile(profileDir, PROFILE_TEMPLATES[profile] ?? DEFAULT_PROFILE_BUNDLES)
    ;(options.stderr ?? process.stderr).write(`ai-agent: initialized profile ${profile} at ${profileDir}\n`)
  }
  const before = readProfileManifest(profileDir)
  const anchoredArgs = args.map(argument => anchorPathSpec(argument, options.cwd ?? process.cwd()))
  const command = anchoredArgs[0]
  if (command === 'add' || command === 'install' || command === 'update') {
    ;(options.stderr ?? process.stderr).write(
      'ai-agent: warning: plugins are trusted local code and run with this process\'s filesystem and network access\n',
    )
  }
  const run = options.run ?? runPnpm
  const exitCode = run('pnpm', anchoredArgs, profileDir)
  if (exitCode !== 0) {
    ;(options.stderr ?? process.stderr).write(`ai-agent: pnpm failed in profile directory ${profileDir}\n`)
    return exitCode
  }
  const inventory = reconcileProfilePlugins(
    before,
    profileDir,
    options.installAnchor ?? DEFAULT_INSTALL_ANCHOR,
    options.stderr ?? process.stderr,
  )
  if (command === 'list') printInventory(inventory, options.stdout ?? process.stdout)
  return 0
}

function runPnpm(command: string, args: readonly string[], cwd: string): number {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      process.stderr.write('ai-agent: pnpm not found on PATH — install pnpm to manage profile plugins\n')
      return 127
    }
    throw result.error
  }
  return result.status ?? 1
}

function printInventory(
  inventory: readonly PluginInventory[],
  stdout: Pick<NodeJS.WriteStream, 'write'>,
): void {
  stdout.write('NAME\tVERSION\tBUNDLE\tCLIENT\tACTIVE\tSPECIFIER\n')
  for (const row of inventory) {
    stdout.write(
      `${row.name}\t${row.version ?? '-'}\t${yesNo(row.bundle)}\t${yesNo(row.client)}\t${yesNo(row.active)}\t${row.specifier}\n`,
    )
  }
}

function readPackageManifest(path: string): ProfileManifest | undefined {
  try {
    const value: unknown = JSON.parse(requireText(path))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    return value as ProfileManifest
  } catch {
    return undefined
  }
}

function requireText(path: string): string {
  return readFileSync(path, 'utf8')
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function yesNo(value: boolean): 'yes' | 'no' {
  return value ? 'yes' : 'no'
}
