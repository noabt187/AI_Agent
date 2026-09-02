import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, test } from 'node:test'
import {
  composeProfileEntries,
  healProfilesModuleFallback,
  initProfile,
  loadProfile,
  readProfileManifest,
  resolveAgentHome,
  resolveProfileDir,
} from '../src/plugins/profile.js'

const roots: string[] = []
const projectRoot = resolve(import.meta.dirname, '..')
const fixturePluginDir = join(projectRoot, 'tests', 'fixtures', 'plugins', 'pagecraft-like')

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ai-agent-profile-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test('resolveAgentHome honors AI_AGENT_HOME and otherwise uses .ai-agent', () => {
  assert.equal(resolveAgentHome({ AI_AGENT_HOME: 'D:\\agent-home' }, 'C:\\Users\\test'), resolve('D:\\agent-home'))
  assert.equal(resolveAgentHome({}, 'C:\\Users\\test'), resolve('C:\\Users\\test', '.ai-agent'))
})

test('initProfile creates a DSH-compatible profile without replacing existing files', async () => {
  const root = await temporaryRoot()
  const dir = join(root, 'profiles', 'web')
  initProfile(dir, ['@ai-agent/base', '@ai-agent/web-app'])
  assert.deepEqual(readProfileManifest(dir).dsh?.profile?.bundles, [
    '@ai-agent/base',
    '@ai-agent/web-app',
  ])
  assert.equal(
    readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
  )
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  initProfile(dir, ['changed'])
  assert.equal(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), '[]\n')
})

test('resolveProfileDir rejects traversal and the shared module directory name', async () => {
  const root = await temporaryRoot()
  for (const name of ['', '.', '..', '../web', 'a\\b', 'node_modules']) {
    assert.throws(() => resolveProfileDir(name, root), /invalid profile name/)
  }
})

test('composeProfileEntries applies bundle layers before the user layer', async () => {
  const root = await temporaryRoot()
  const profileDir = resolveProfileDir('test', root)
  initProfile(profileDir, ['pagecraft-like'])
  const linkedPackage = join(profileDir, 'node_modules', 'pagecraft-like')
  mkdirSync(dirname(linkedPackage), { recursive: true })
  symlinkSync(fixturePluginDir, linkedPackage, process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(
    join(profileDir, 'cordis.patch.yml'),
    '- id: frontend-feedback\n  config:\n    requestTimeoutMs: 9000\n',
  )
  const profile = loadProfile('test', join(projectRoot, 'package.json'), root)
  const entries = composeProfileEntries(profile)
  assert.equal(entries.find(row => row.id === 'frontend-feedback')?.config?.requestTimeoutMs, 9000)
})

test('loadProfile rejects a non-array Cordis patch', async () => {
  const root = await temporaryRoot()
  const profileDir = resolveProfileDir('test', root)
  initProfile(profileDir, [])
  writeFileSync(join(profileDir, 'cordis.patch.yml'), 'invalid: true\n')
  assert.throws(() => loadProfile('test', join(projectRoot, 'package.json'), root), /top-level array/)
})

test('healProfilesModuleFallback exposes one shared Cordis package to every profile', async () => {
  const root = await temporaryRoot()
  const installDir = join(root, 'installation')
  const cordisDir = join(installDir, 'node_modules', '@deepseek-ai', 'cordis')
  mkdirSync(cordisDir, { recursive: true })
  writeFileSync(
    join(installDir, 'package.json'),
    JSON.stringify({ name: 'fixture-host', dependencies: { '@deepseek-ai/cordis': '4.0.1' } }),
  )
  writeFileSync(join(cordisDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis', version: '4.0.1' }))

  healProfilesModuleFallback(join(installDir, 'package.json'), root)
  const link = join(root, 'profiles', 'node_modules', '@deepseek-ai', 'cordis')
  assert.equal(existsSync(link), true)
  assert.equal(realpathSync(link).toLowerCase(), realpathSync(cordisDir).toLowerCase())
})
