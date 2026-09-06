import assert from 'node:assert/strict'
import test from 'node:test'
import { IndexedDbDraftStorage } from '../src/client/source-drafts.ts'

test('IndexedDB writes reject when transaction aborts after request success', async () => {
  const transaction: any = {
    error: new Error('late abort'),
    objectStore: () => ({ put: () => request }),
  }
  const request: any = { result: undefined }
  const database: any = { transaction: () => transaction }
  const openRequest: any = { result: database }
  const factory: any = { open: () => openRequest }
  const storage = new IndexedDbDraftStorage(factory)
  queueMicrotask(() => openRequest.onsuccess())
  const pending = storage.put({ key: 'k', sessionId: 's', rootPath: '/', selectedFolder: '.', path: 'a.ts', baseHash: 'h', content: 'x', revision: 1, updatedAt: 1 })
  await Promise.resolve()
  await Promise.resolve()
  request.onsuccess()
  transaction.onabort()
  await assert.rejects(pending, /late abort/)
})
