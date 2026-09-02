import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test, { afterEach } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { bootPluginHost } from '../src/plugins/host.js'
import coreRoutesPlugin from '../src/server/coreRoutes.js'
import staticWebPlugin from '../src/server/staticWeb.js'

const fixtureBaseUrl = pathToFileURL(`${import.meta.dirname}/`).href
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const pagecraftProbePlugin = {
  inject: ['webServer'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/frontend-feedback/probe',
      handler: (_req, res) => res.end('pagecraft'),
    }), 'pagecraft probe route')
  },
}

const probeRoutePlugin = {
  inject: ['webServer'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/probe',
      handler: (_req, res) => res.end('ok'),
    }), 'disposable probe route')
  },
}

async function bootTestWebHost(
  plugins: Array<{ id: string; name: string; plugin: unknown; config?: unknown }>,
) {
  const builtins = Object.fromEntries(plugins.map(item => [item.name.replace(/^cordis:/, ''), item.plugin]))
  const host = await bootPluginHost({
    entries: [
      {
        id: 'web-server',
        name: '@deepseek-ai/dsh-host-webserver',
        config: { host: '127.0.0.1', port: 0 },
      },
      ...plugins.map(item => ({ id: item.id, name: item.name, config: item.config })),
    ],
    builtins,
    baseUrl: fixtureBaseUrl,
  })
  return {
    ...host,
    url: (path: string) => `http://127.0.0.1:${host.ctx.webServer.port}${path}`,
    remove: (id: string) => host.ctx.loader.remove(id),
  }
}

test('an exact PageCraft route wins before the built-in /api prefix', async () => {
  const host = await bootTestWebHost([
    { id: 'core-routes', name: 'cordis:core-routes', plugin: coreRoutesPlugin },
    { id: 'pagecraft-probe', name: 'cordis:pagecraft-probe', plugin: pagecraftProbePlugin },
  ])
  assert.equal(await (await fetch(host.url('/api/frontend-feedback/probe'))).text(), 'pagecraft')
  assert.deepEqual(await (await fetch(host.url('/api/health'))).json(), { ok: true })
  await host.dispose()
})

test('disposing a route fiber makes its endpoint unavailable', async () => {
  const host = await bootTestWebHost([
    { id: 'probe-route', name: 'cordis:probe-route', plugin: probeRoutePlugin },
  ])
  assert.equal((await fetch(host.url('/probe'))).status, 200)
  await host.remove('probe-route')
  assert.equal((await fetch(host.url('/probe'))).status, 404)
  await host.dispose()
})

test('static fallback serves the SPA but never escapes its configured root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-agent-static-'))
  roots.push(root)
  await mkdir(join(root, 'assets'))
  writeFileSync(join(root, 'index.html'), '<main>shell</main>')
  writeFileSync(join(root, 'assets', 'app.js'), 'export const ok = true')
  const host = await bootTestWebHost([
    { id: 'static-web', name: 'cordis:static-web', plugin: staticWebPlugin, config: { root } },
  ])
  assert.equal(await (await fetch(host.url('/assets/app.js'))).text(), 'export const ok = true')
  assert.equal(await (await fetch(host.url('/some/spa/path'))).text(), '<main>shell</main>')
  assert.equal(await (await fetch(host.url('/..%2Fpackage.json'))).text(), '<main>shell</main>')
  await host.dispose()
})
