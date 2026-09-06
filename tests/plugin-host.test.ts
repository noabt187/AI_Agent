import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test, { afterEach } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { INSTALL_ANCHOR, bootPluginHost, prepareAiAgentProfile } from '../src/plugins/host.js'

const fixtureBaseUrl = pathToFileURL(`${import.meta.dirname}/`).href
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test('bootPluginHost loads builtins and disposes their effects in reverse order', async () => {
  const events: string[] = []
  const host = await bootPluginHost({
    entries: [{ id: 'probe', name: 'cordis:probe' }],
    baseUrl: fixtureBaseUrl,
    builtins: {
      probe: {
        apply(ctx: Context) {
          ctx.effect(() => {
            events.push('first:start')
            return () => { events.push('first:stop') }
          }, 'first')
          ctx.effect(() => {
            events.push('second:start')
            return () => { events.push('second:stop') }
          }, 'second')
        },
      },
    },
  })
  assert.deepEqual(events, ['first:start', 'second:start'])
  await host.dispose()
  await host.dispose()
  assert.deepEqual(events, ['first:start', 'second:start', 'second:stop', 'first:stop'])
})

test('bootPluginHost names an entry whose required service never activates', async () => {
  await assert.rejects(
    () => bootPluginHost({
      entries: [{ id: 'missing-service', name: 'cordis:missing-service' }],
      baseUrl: fixtureBaseUrl,
      builtins: {
        'missing-service': {
          inject: ['sessions'],
          apply() {},
        },
      },
    }),
    /missing-service.*sessions/s,
  )
})

test('bootPluginHost unwinds already-started siblings when another entry fails', async () => {
  const events: string[] = []
  await assert.rejects(
    () => bootPluginHost({
      entries: [
        { id: 'started', name: 'cordis:started' },
        { id: 'broken', name: 'cordis:broken' },
      ],
      baseUrl: fixtureBaseUrl,
      builtins: {
        started: {
          apply(ctx: Context) {
            ctx.effect(() => {
              events.push('start')
              return () => { events.push('stop') }
            })
          },
        },
        broken: { apply() { throw new Error('fixture failure') } },
      },
    }),
    /fixture failure/,
  )
  assert.deepEqual(events, ['start', 'stop'])
})

test('prepareAiAgentProfile composes the shipped base and web bundles', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ai-agent-host-'))
  roots.push(home)
  const prepared = prepareAiAgentProfile('web', { home, installAnchor: INSTALL_ANCHOR })
  assert.ok(prepared.entries.some(entry => entry.id === 'skills'))
  assert.ok(prepared.entries.some(entry => entry.id === 'web-server'))
  assert.equal(existsSync(join(prepared.profile.dir, 'cordis.yml')), true)
})
