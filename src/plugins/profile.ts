import { createRequire } from 'node:module'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import yaml from 'js-yaml'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type {
  EntryOptions,
  LoadedProfile,
  PatchOptions,
  ProfileLayer,
  ProfileManifest,
} from './types.js'

export const PROFILES_DIR = 'profiles'
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'
export const PROFILE_TEMPLATES: Readonly<Record<string, readonly string[]>> = {
  web: ['@ai-agent/base', '@ai-agent/web-app'],
}
export const DEFAULT_PROFILE_BUNDLES: readonly string[] = ['@ai-agent/base']

const PROFILE_PATCH_TEMPLATE = `# AI Agent profile overrides, applied after every bundle layer.
[]
`

const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

export function resolveAgentHome(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): string {
  const configured = env.AI_AGENT_HOME?.trim()
  if (configured) return isAbsolute(configured) ? resolve(configured) : resolve(process.cwd(), configured)
  return resolve(userHome, '.ai-agent')
}

export function resolveProfileDir(name: string, home: string = resolveAgentHome()): string {
  if (
    name === ''
    || name === '.'
    || name === '..'
    || name === 'node_modules'
    || name.includes('/')
    || name.includes('\\')
  ) {
    throw new Error(`ai-agent: invalid profile name ${JSON.stringify(name)}`)
  }
  return join(home, PROFILES_DIR, name)
}

export function initProfile(dir: string, bundles: readonly string[]): void {
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    const manifest: ProfileManifest = {
      name: `ai-agent-profile-${basename(dir)}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...bundles] } },
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  }
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE)
  const workspacePath = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) writeFileSync(workspacePath, PROFILE_PNPM_WORKSPACE)
}

export function readProfileManifest(dir: string): ProfileManifest {
  const manifestPath = join(dir, 'package.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`ai-agent: failed to read profile manifest ${manifestPath}: ${String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`ai-agent: profile manifest ${manifestPath} must contain a JSON object`)
  }
  const manifest = parsed as ProfileManifest
  if (manifest.dependencies !== undefined && !isStringMap(manifest.dependencies)) {
    throw new Error(`ai-agent: profile manifest ${manifestPath} has invalid dependencies`)
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (bundles !== undefined && (!Array.isArray(bundles) || bundles.some(item => typeof item !== 'string' || item === ''))) {
    throw new Error(`ai-agent: profile manifest ${manifestPath} has invalid dsh.profile.bundles`)
  }
  return manifest
}

export function writeProfileManifest(dir: string, manifest: ProfileManifest): void {
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
}

export function resolvePackageDir(packageName: string, ...anchors: readonly string[]): string | undefined {
  for (const anchor of anchors) {
    for (const searchPath of createRequire(anchor).resolve.paths(packageName) ?? []) {
      const candidate = join(searchPath, packageName)
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
  }
  return undefined
}

export function resolveBundleDir(packageName: string, installAnchor: string, profileDir: string): string {
  const packageDir = resolvePackageDir(packageName, installAnchor, join(profileDir, 'package.json'))
  if (packageDir !== undefined) return packageDir
  throw new Error(
    `ai-agent: cannot resolve profile bundle ${JSON.stringify(packageName)} from the installation or ${profileDir}; `
    + `run 'ai-agent plugin --profile ${basename(profileDir)} install'`,
  )
}

export function healProfilesModuleFallback(
  installAnchor: string,
  home: string = resolveAgentHome(),
): void {
  const modulesDir = join(home, PROFILES_DIR, 'node_modules')
  mkdirSync(modulesDir, { recursive: true })
  const rootManifest = parseManifestFile(installAnchor)
  const links = new Map<string, string>()
  if (rootManifest.name) links.set(rootManifest.name, dirname(installAnchor))
  const queue: Array<{ anchor: string; manifest: ProfileManifest }> = [
    { anchor: installAnchor, manifest: rootManifest },
  ]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const names = [
      ...Object.keys(next.manifest.dependencies ?? {}),
      ...Object.keys(next.manifest.peerDependencies ?? {}),
    ]
    for (const packageName of names) {
      if (links.has(packageName)) continue
      const packageDir = resolvePackageDir(packageName, next.anchor)
      if (packageDir === undefined) continue
      links.set(packageName, packageDir)
      const manifestPath = join(packageDir, 'package.json')
      queue.push({ anchor: manifestPath, manifest: parseManifestFile(manifestPath) })
    }
  }
  for (const [packageName, target] of links) {
    const link = join(modulesDir, packageName)
    mkdirSync(dirname(link), { recursive: true })
    ensureManagedLink(link, target)
  }
}

export function loadProfile(
  name: string,
  installAnchor: string,
  home: string = resolveAgentHome(),
): LoadedProfile {
  const dir = resolveProfileDir(name, home)
  if (!existsSync(join(dir, 'package.json'))) {
    const template = PROFILE_TEMPLATES[name]
    if (template === undefined) {
      throw new Error(
        `ai-agent: profile ${JSON.stringify(name)} does not exist; create it with `
        + `'ai-agent plugin --profile ${name} add <package>'`,
      )
    }
    initProfile(dir, template)
  }
  const manifest = readProfileManifest(dir)
  const layers = (manifest.dsh?.profile?.bundles ?? []).map((packageName): ProfileLayer => {
    const packageDir = resolveBundleDir(packageName, installAnchor, dir)
    const packageManifest = parseManifestFile(join(packageDir, 'package.json'))
    const declaredPatch = packageManifest.dsh?.bundle?.patch
    if (typeof declaredPatch !== 'string' || declaredPatch === '') {
      throw new Error(
        `ai-agent: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle.patch`,
      )
    }
    const patchPath = resolve(packageDir, declaredPatch)
    return {
      packageName,
      packageDir,
      patchPath,
      patches: loadPatchFile(patchPath),
    }
  })
  const userPatchPath = join(dir, PROFILE_PATCH_FILENAME)
  const userPatches = existsSync(userPatchPath) ? loadPatchFile(userPatchPath) : []
  return { name, dir, manifest, layers, userPatchPath, userPatches }
}

export function composeProfileEntries(profile: LoadedProfile): EntryOptions[] {
  const patches = [...profile.layers.flatMap(layer => layer.patches), ...profile.userPatches]
  return applyEntryPatches([], structuredClone(patches), formatPatchWarning)
}

function loadPatchFile(path: string): PatchOptions[] {
  let parsed: unknown
  try {
    parsed = yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema })
  } catch (error) {
    throw new Error(`ai-agent: failed to parse Cordis patch ${path}: ${String(error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`ai-agent: Cordis patch ${path} must contain a top-level array`)
  }
  return parsed as PatchOptions[]
}

function parseManifestFile(path: string): ProfileManifest {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`ai-agent: package manifest ${path} must contain a JSON object`)
  }
  return parsed as ProfileManifest
}

function isStringMap(value: unknown): value is Record<string, string> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every(item => typeof item === 'string')
}

function ensureManagedLink(link: string, target: string): void {
  let stat: ReturnType<typeof lstatSync> | undefined
  try {
    stat = lstatSync(link)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (stat !== undefined) {
    if (!stat.isSymbolicLink()) {
      throw new Error(`ai-agent: ${link} exists and is not a managed symlink or junction`)
    }
    try {
      if (sameRealPath(realpathSync(link), realpathSync(target))) return
    } catch {
      if (readlinkSync(link) === target) return
    }
    unlinkSync(link)
  }
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

function sameRealPath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function formatPatchWarning(message: string, ...args: unknown[]): void {
  let index = 0
  const rendered = message.replace(/%C/g, () => JSON.stringify(args[index++]))
  process.stderr.write(`ai-agent: ${rendered}\n`)
}
