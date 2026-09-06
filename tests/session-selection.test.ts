import assert from 'node:assert/strict'
import test from 'node:test'
import { readSelectedSession, saveSelectedSession, selectExistingSession } from '../web/src/sessionSelection.js'

test('restores selection rather than newest session and falls back only when missing', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  saveSelectedSession('older', storage)
  assert.equal(selectExistingSession(['newer', 'older'], readSelectedSession(storage)), 'older')
  assert.equal(selectExistingSession(['newer'], readSelectedSession(storage)), 'newer')
  assert.equal(selectExistingSession([], 'older'), '')
  saveSelectedSession('', storage)
  assert.equal(readSelectedSession(storage), '')
  assert.equal(readSelectedSession({getItem: () => { throw Error('blocked') }}), '')
})
