import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test, { afterEach } from 'node:test'
import { bootPluginHost } from '../src/plugins/host.js'
import clientModulesPlugin, {
  type ClientManifest,
  type ClientModuleRegistry,
} from '../src/plugins/clientModules.js'

const fixtureDir = resolve(import.meta.dirname, 'fixtures/plugins/client-probe')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function bootClientHost() {
  const profileDir = await mkdtemp(join(tmpdir(), 'ai-agent-client-modules-'))
  roots.push(profileDir)
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'client-module-test', private: true }))
  await mkdir(join(profileDir, 'node_modules'))
  await symlink(fixtureDir, join(profileDir, 'node_modules', 'client-probe'), process.platform === 'win32' ? 'junction' : 'dir')
  const host = await bootPluginHost({
    entries: [
      {
        id: 'web-server',
        name: '@deepseek-ai/dsh-host-webserver',
        config: { host: '127.0.0.1', port: 0 },
      },
      { id: 'client-modules', name: 'cordis:client-modules' },
      { id: 'client-probe', name: 'client-probe' },
    ],
    baseUrl: pathToFileURL(join(profileDir, 'package.json')).href,
    builtins: { 'client-modules': clientModulesPlugin },
  })
  return {
    ...host,
    registry: host.ctx.get('clientModules') as ClientModuleRegistry,
    url: (path: string) => `http://127.0.0.1:${host.ctx.webServer.port}${path}`,
  }
}

test('discovers active dsh.client plugins and serves their exact exported artifacts', async (t) => {
  const host = await bootClientHost()
  t.after(() => host.dispose())
  const manifest = host.registry.manifest()
  assert.equal(manifest.modules.length, 1)
  assert.equal(manifest.modules[0]?.id, 'client-probe')
  assert.deepEqual(manifest.modules[0]?.inject, ['slots'])
  assert.match(manifest.modules[0]?.url ?? '', /^\/plugins\/client-probe\/client\.js\?rev=[a-f0-9]{12}$/)

  const manifestResponse = await fetch(host.url('/api/plugins/client-manifest'))
  assert.equal(manifestResponse.status, 200)
  assert.deepEqual(await manifestResponse.json() as ClientManifest, manifest)

  const artifactResponse = await fetch(host.url(manifest.modules[0]!.url))
  assert.equal(artifactResponse.status, 200)
  assert.equal(artifactResponse.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.match(await artifactResponse.text(), /__ModuleLoader__\.load/)
  assert.equal(host.registry.resolveArtifact('/plugins/../package.json'), undefined)
  assert.equal(existsSync(host.registry.resolveArtifact('/plugins/client-probe/client.js')!.path), true)
})

test('unloading a plugin removes its client module and invalidates the artifact URL', async (t) => {
  const host = await bootClientHost()
  t.after(() => host.dispose())
  const oldUrl = host.registry.manifest().modules[0]!.url
  await host.ctx.loader.remove('client-probe')

  assert.deepEqual(host.registry.manifest().modules, [])
  assert.equal((await fetch(host.url(oldUrl))).status, 404)
})
