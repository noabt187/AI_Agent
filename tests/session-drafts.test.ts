import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionDraftStore } from '../web/src/sessionDrafts.js'

test('drafts are isolated and restored, stale acceptance cannot clear new input', () => {
  const data = new Map<string, string>()
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, removeItem: (k: string) => { data.delete(k) } }
  const store = new SessionDraftStore(storage)
  store.set('a', 'draft A')
  const sent = store.get('a')
  assert.equal(store.get('b').text, '')
  store.set('b', 'draft B')
  store.set('a', 'new A')
  store.accept('a', sent.revision)
  assert.equal(store.get('a').text, 'new A')
  assert.equal(new SessionDraftStore(storage).get('b').text, 'draft B')
  store.accept('a', store.get('a').revision)
  assert.equal(store.get('a').text, '')
  assert.equal(store.get('b').text, 'draft B')
})

test('storage failure preserves in-memory unsent draft', () => {
  const broken = () => { throw new Error('unavailable') }
  const store = new SessionDraftStore({ getItem: broken, setItem: broken, removeItem: broken })
  store.set('a', 'unsent')
  assert.equal(store.get('a').text, 'unsent')
})
