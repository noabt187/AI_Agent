import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, test } from 'node:test'
import { main } from '../scripts/ai-agent.js'
import {
  anchorPathSpec,
  reconcileProfilePlugins,
  runPluginCommand,
} from '../src/plugins/manager.js'
import {
  initProfile,
  readProfileManifest,
  resolveProfileDir,
  writeProfileManifest,
} from '../src/plugins/profile.js'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ai-agent-manager-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test('anchorPathSpec resolves only relative package paths against the invoking cwd', () => {
  const cwd = resolve('D:\\work\\agent')
  assert.equal(anchorPathSpec('../PageCraft', cwd), resolve(cwd, '../PageCraft'))
  assert.equal(anchorPathSpec('file:./PageCraft', cwd), `file:${resolve(cwd, './PageCraft')}`)
  assert.equal(anchorPathSpec('github:noabt187/dsh-PageCraft', cwd), 'github:noabt187/dsh-PageCraft')
  assert.equal(anchorPathSpec('@scope/plugin@next', cwd), '@scope/plugin@next')
})

test('reconciliation appends real bundle dependencies and removes deleted ones', async () => {
  const root = await temporaryRoot()
  const profileDir = resolveProfileDir('web', root)
  initProfile(profileDir, ['@ai-agent/base', '@ai-agent/web-app', 'removed-bundle'])
  const before = readProfileManifest(profileDir)
  before.dependencies = { 'removed-bundle': '1.0.0' }
  writeProfileManifest(profileDir, before)

  const packageDir = join(profileDir, 'node_modules', 'dsh-frontend-feedback')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: 'dsh-frontend-feedback',
    version: '0.3.0',
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
  }))
  const after = readProfileManifest(profileDir)
  after.dependencies = { 'dsh-frontend-feedback': 'file:plugin' }
  writeProfileManifest(profileDir, after)

  const inventory = reconcileProfilePlugins(before, profileDir, join(profileDir, 'package.json'))
  assert.deepEqual(readProfileManifest(profileDir).dsh?.profile?.bundles, [
    '@ai-agent/base',
    '@ai-agent/web-app',
    'dsh-frontend-feedback',
  ])
  assert.deepEqual(inventory[0], {
    name: 'dsh-frontend-feedback',
    specifier: 'file:plugin',
    version: '0.3.0',
    bundle: true,
    client: true,
    active: true,
  })
})

test('runPluginCommand anchors paths, prints trust, and reconciles only after success', async () => {
  const root = await temporaryRoot()
  const stderr: string[] = []
  let seenArgs: readonly string[] = []
  const result = runPluginCommand('custom', ['add', '../plugin'], {
    home: root,
    cwd: join(root, 'caller'),
    installAnchor: join(resolve(import.meta.dirname, '..'), 'package.json'),
    stderr: { write(value) { stderr.push(String(value)); return true } },
    run(_command, args, profileDir) {
      seenArgs = args
      const manifest = readProfileManifest(profileDir)
      manifest.dependencies = {}
      writeProfileManifest(profileDir, manifest)
      return 0
    },
  })
  assert.equal(result, 0)
  assert.equal(seenArgs[1], resolve(root, 'plugin'))
  assert.match(stderr.join(''), /trusted local code/)
})

test('main prints CLI forms without creating a profile', async () => {
  const output: string[] = []
  const code = await main(['--help'], {
    stdout: { write(value) { output.push(String(value)); return true } },
    stderr: { write(value) { output.push(String(value)); return true } },
  })
  assert.equal(code, 0)
  assert.match(output.join(''), /ai-agent plugin --profile <name>/)
})
