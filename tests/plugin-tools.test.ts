import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { bootPluginHost } from '../src/plugins/host.js'
import { toolRegistryPlugin } from '../src/plugins/services/tools.js'

const fixtureBaseUrl = pathToFileURL(`${import.meta.dirname}/`).href

test('plugin tools join the Agent catalog and disappear with their fiber', async () => {
  const probe = {
    inject: ['tools'],
    apply(ctx: Context) {
      ctx.tools.register('pluginProbe', {
        scope: 'read',
        description: 'Plugin probe',
        argNames: ['value'],
        fn: async (rootDir, value) => `${rootDir}:${value}`,
      })
    },
  }
  const host = await bootPluginHost({
    baseUrl: fixtureBaseUrl,
    entries: [
      { id: 'tools', name: 'cordis:tools' },
      { id: 'probe', name: 'cordis:probe' },
    ],
    builtins: { tools: toolRegistryPlugin, probe },
  })
  assert.ok(host.ctx.tools.definitions('read').some(tool => tool.function.name === 'pluginProbe'))
  assert.equal(await host.ctx.tools.execute({
    name: 'pluginProbe',
    args: { value: 'ok' },
    allowedPaths: ['D:\\workspace'],
  }), 'D:\\workspace:ok')
  await host.ctx.loader.remove('probe')
  assert.ok(!host.ctx.tools.definitions('read').some(tool => tool.function.name === 'pluginProbe'))
  await host.dispose()
})

test('the Cordis registry preserves write confirmation gates', async () => {
  let invoked = false
  const probe = {
    inject: ['tools'],
    apply(ctx: Context) {
      ctx.tools.register('writeProbe', {
        scope: 'write',
        description: 'Write probe',
        argNames: [],
        fn: async () => {
          invoked = true
          return 'written'
        },
      })
    },
  }
  const host = await bootPluginHost({
    baseUrl: fixtureBaseUrl,
    entries: [
      { id: 'tools', name: 'cordis:tools' },
      { id: 'probe', name: 'cordis:probe' },
    ],
    builtins: { tools: toolRegistryPlugin, probe },
  })
  assert.match(await host.ctx.tools.execute({
    name: 'writeProbe',
    args: {},
    allowedPaths: [process.cwd()],
    designConfirmed: false,
  }), /未确认方案/)
  assert.equal(invoked, false)
  assert.equal(await host.ctx.tools.execute({
    name: 'writeProbe',
    args: {},
    allowedPaths: [process.cwd()],
    designConfirmed: true,
  }), 'written')
  assert.equal(invoked, true)
  await host.dispose()
})

test('built-in tools remain available through the Cordis registry', async () => {
  const host = await bootPluginHost({
    baseUrl: fixtureBaseUrl,
    entries: [{ id: 'tools', name: 'cordis:tools' }],
    builtins: { tools: toolRegistryPlugin },
  })
  const names = host.ctx.tools.definitions('write').map(tool => tool.function.name)
  assert.ok(names.includes('readTextFile'))
  assert.ok(names.includes('writeFile'))
  assert.ok(names.includes('forkRepository'))
  await host.dispose()
})
