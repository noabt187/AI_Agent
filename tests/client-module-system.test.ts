import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import { ClientModuleSystem } from '../web/src/plugins/clientModuleSystem.js'

afterEach(() => {
  delete (globalThis as { __ModuleLoader__?: unknown }).__ModuleLoader__
})

test('the DSH wrapper registers once and materializes with host React modules', async (t) => {
  const system = new ClientModuleSystem({
    modules: [{ id: 'probe', url: '/probe.js', rev: 'abc' }],
    seeds: { react: React, 'react/jsx-runtime': jsxRuntime, 'react-dom': ReactDOM },
    loadBundle: async () => globalThis.__ModuleLoader__!.load({
      id: 'probe',
      factory: require => ({ react: require('react') }),
    }),
  })
  t.after(() => system.dispose())
  assert.equal((await system.import('probe')).react, React)
  assert.equal(await system.import('probe/client'), await system.import('probe'))
  await assert.rejects(() => system.import('missing'), /cannot resolve "missing"/)
})

test('duplicate rows, factories, and synchronous factory cycles fail loudly', async () => {
  assert.throws(() => new ClientModuleSystem({
    modules: [
      { id: 'duplicate', url: '/a.js', rev: 'a' },
      { id: 'duplicate', url: '/b.js', rev: 'b' },
    ],
    seeds: {},
  }), /duplicate graph entry/)

  const system = new ClientModuleSystem({
    modules: [
      { id: 'a', url: '/a.js', rev: 'a' },
      { id: 'b', url: '/b.js', rev: 'b' },
    ],
    seeds: {},
    loadBundle: async () => {},
  })
  globalThis.__ModuleLoader__!.load({ id: 'a', factory: require => ({ b: require('b') }) })
  globalThis.__ModuleLoader__!.load({ id: 'b', factory: require => ({ a: require('a') }) })
  assert.throws(
    () => globalThis.__ModuleLoader__!.load({ id: 'a', factory: () => ({}) }),
    /duplicate factory registration/,
  )
  await assert.rejects(() => system.import('a'), /require cycle through "a"/)
  system.dispose()
})
