import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { bootPluginHost } from '../src/plugins/host.js'
import { toolRegistryPlugin } from '../src/plugins/services/tools.js'
import { CommandError } from '../src/utils/command.js'

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

test('structured plugin execution retains error codes, cancellation, and legacy text consumers', async t => {
  let seenSignal: AbortSignal | undefined
  const host = await bootPluginHost({
    baseUrl: fixtureBaseUrl,
    entries: [{ id: 'tools', name: 'cordis:tools' }, { id: 'probe', name: 'cordis:probe' }],
    builtins: {
      tools: toolRegistryPlugin,
      probe: { inject: ['tools'], apply(ctx: Context) {
        ctx.tools.register('statusProbe', {
          scope: 'read', description: 'Status probe', argNames: ['status'],
          fn: async (_root, status) => status === 'fail' ? '错误：probe failed' : 'probe succeeded',
        })
        ctx.tools.register('abortProbe', {
          scope: 'read', description: 'Abort probe', argNames: [],
          fn: async () => { throw new Error('must use signal-aware implementation') },
          withSignal: async (_root, _args, signal) => {
            seenSignal = signal
            throw new CommandError('aborted', 'cancelled', 'partial output')
          },
        })
      } },
    },
  })
  t.after(() => host.dispose())
  const request = { name: 'statusProbe', args: { status: 'fail' }, allowedPaths: [process.cwd()] }
  assert.equal((await host.ctx.tools.executeResult(request)).code, 'TOOL_EXECUTION_FAILED')
  assert.equal(await host.ctx.tools.execute(request), '错误：probe failed')
  assert.equal((await host.ctx.tools.executeResult({ ...request, args: { status: 'ok' } })).ok, true)
  assert.equal(await host.ctx.tools.execute({ ...request, args: { status: 'ok' } }), 'probe succeeded')
  const controller = new AbortController()
  const aborted = await host.ctx.tools.executeResult({ name: 'abortProbe', args: {}, allowedPaths: [process.cwd()], signal: controller.signal })
  assert.equal(seenSignal, controller.signal)
  assert.equal(aborted.code, 'ABORTED')
  assert.equal(aborted.data?.stdout, 'partial output')
  assert.equal((await host.ctx.tools.executeResult({ ...request, name: 'missing' })).code, 'UNKNOWN_TOOL')
})

test('local-only evaluation blocks remote builtin tools through both Cordis entry points', async t => {
  const previous = process.env.AGENT_EVAL_LOCAL_ONLY
  process.env.AGENT_EVAL_LOCAL_ONLY = '1'
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_EVAL_LOCAL_ONLY
    else process.env.AGENT_EVAL_LOCAL_ONLY = previous
  })
  const host = await bootPluginHost({ baseUrl: fixtureBaseUrl, entries: [{ id: 'tools', name: 'cordis:tools' }], builtins: { tools: toolRegistryPlugin } })
  t.after(() => host.dispose())
  for (const name of ['createPullRequest', 'forkRepository', 'cloneRepository']) {
    const request = { name, args: { rootDir: process.cwd(), repoUrl: 'owner/repo' }, allowedPaths: [process.cwd()], designConfirmed: true }
    assert.equal((await host.ctx.tools.executeResult(request)).code, 'REMOTE_SIDE_EFFECT_BLOCKED')
    assert.match(await host.ctx.tools.execute(request), /本地评测模式已阻断/)
  }
})
