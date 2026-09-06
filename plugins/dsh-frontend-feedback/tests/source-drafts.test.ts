import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MemoryDraftStorage,
  SourceDraftCache,
  diskSaveStatus,
  draftAfterQueuedOperation,
  isDraftCacheAllowed,
  sourceDraftKey,
} from '../src/client/source-drafts.ts'

const scope = { sessionId: 'session-a', rootPath: 'C:\\Work\\Site', selectedFolder: 'app', path: 'src/main.ts' }

test('draft keys isolate session, canonical root, folder, and relative path', () => {
  assert.equal(sourceDraftKey(scope), sourceDraftKey({ ...scope, rootPath: 'c:/work/site/' }))
  assert.notEqual(sourceDraftKey(scope), sourceDraftKey({ ...scope, sessionId: 'session-b' }))
  assert.notEqual(sourceDraftKey(scope), sourceDraftKey({ ...scope, selectedFolder: 'other' }))
  assert.notEqual(sourceDraftKey(scope), sourceDraftKey({ ...scope, path: 'src/other.ts' }))
})

test('draft survives a new cache instance and reports disk conflicts', async () => {
  const storage = new MemoryDraftStorage()
  const first = new SourceDraftCache(storage)
  const saved = await first.persist(scope, 'disk-a', 'edited')
  assert.equal(saved.ok, true)
  const second = new SourceDraftCache(storage)
  assert.deepEqual(await second.restore(scope, 'disk-a'), { kind: 'recovered', content: 'edited', revision: 1 })
  assert.deepEqual(await second.restore(scope, 'disk-b'), {
    kind: 'conflict', content: 'edited', revision: 1, baseHash: 'disk-a', diskHash: 'disk-b',
  })
})

test('clearing saved revision N preserves edits persisted as N+1', async () => {
  const storage = new MemoryDraftStorage()
  const cache = new SourceDraftCache(storage)
  const first = await cache.persist(scope, 'disk-a', 'one')
  const second = await cache.persist(scope, 'disk-a', 'two')
  assert.equal(first.ok && first.revision, 1)
  assert.equal(second.ok && second.revision, 2)
  assert.equal(await cache.clearSaved(scope, 1), false)
  assert.equal((await cache.restore(scope, 'disk-a')).kind, 'recovered')
  assert.equal(await cache.clearSaved(scope, 2), true)
  assert.deepEqual(await cache.restore(scope, 'disk-a'), { kind: 'none' })
})

test('storage failure is returned to callers as a visible warning condition', async () => {
  const storage = new MemoryDraftStorage()
  storage.failure = new Error('quota exceeded')
  const result = await new SourceDraftCache(storage).persist(scope, 'disk-a', 'edited')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error.message, /quota exceeded/)
})

test('explicit discard deletes only the selected file draft', async () => {
  const storage = new MemoryDraftStorage()
  const cache = new SourceDraftCache(storage)
  await cache.persist(scope, 'disk-a', 'one')
  const other = { ...scope, path: 'src/other.ts' }
  await cache.persist(other, 'disk-b', 'two')
  await cache.discard(scope)
  assert.deepEqual(await cache.restore(scope, 'disk-a'), { kind: 'none' })
  assert.equal((await cache.restore(other, 'disk-b')).kind, 'recovered')
})

test('discard waits for an in-flight persist and cannot be resurrected', async () => {
  class PausedStorage extends MemoryDraftStorage {
    release: (() => void) | null = null
    override async put(record: Parameters<MemoryDraftStorage['put']>[0]): Promise<void> {
      await new Promise<void>(resolve => { this.release = resolve })
      await super.put(record)
    }
  }
  const storage = new PausedStorage()
  const cache = new SourceDraftCache(storage)
  const pending = cache.persist(scope, 'disk-a', 'one')
  while (storage.release === null) await Promise.resolve()
  const discarded = cache.discard(scope)
  storage.release()
  await pending
  await discarded
  assert.deepEqual(await cache.restore(scope, 'disk-a'), { kind: 'none' })
})

test('draft capacity fails visibly without evicting existing unsaved records', async () => {
  const storage = new MemoryDraftStorage()
  const cache = new SourceDraftCache(storage)
  for (let index = 0; index < 100; index += 1) {
    assert.equal((await cache.persist({ ...scope, path: `file-${index}.ts` }, 'disk', String(index))).ok, true)
  }
  const overflow = await cache.persist({ ...scope, path: 'overflow.ts' }, 'disk', 'overflow')
  assert.equal(overflow.ok, false)
  if (!overflow.ok) assert.match(overflow.error.message, /100/)
  assert.equal((await storage.list()).length, 100)
  assert.equal((await cache.restore({ ...scope, path: 'file-0.ts' }, 'disk')).kind, 'recovered')
})

test('sensitive credential filenames are never cacheable', () => {
  for (const path of ['.env', '.env.local', 'server.pem', 'id_rsa', 'credentials.json', 'service-account.json', 'client-secret.json', 'my-credentials.json', 'private-key.json', 'prod_api-key.yaml']) {
    assert.equal(isDraftCacheAllowed(path), false, path)
  }
  for (const path of ['.gitignore', 'LICENSE', 'Dockerfile', 'src/main.ts']) {
    assert.equal(isDraftCacheAllowed(path), true, path)
  }
})

test('restore refuses legacy sensitive records without reading their contents', async () => {
  const storage = new MemoryDraftStorage()
  const sensitive = { ...scope, path: 'my-credentials.json' }
  storage.records.set(sourceDraftKey(sensitive), { ...sensitive, key: sourceDraftKey(sensitive), baseHash: 'disk', content: 'secret', revision: 1, updatedAt: 1 })
  assert.deepEqual(await new SourceDraftCache(storage).restore(sensitive, 'disk'), { kind: 'none' })
})

test('disk save status preserves persistence failures and newer-edit state', () => {
  assert.equal(diskSaveStatus('a.ts', true, 'quota warning'), 'quota warning')
  assert.match(diskSaveStatus('a.ts', true, null), /较新的修改仍未保存/)
  assert.match(diskSaveStatus('a.ts', false, null), /正在同步预览/)
})

test('post-save re-read observes edit C made while cleanup of saved B awaits', async () => {
  let current = 'B'
  let release!: () => void
  const cleanup = new Promise<void>(resolve => { release = resolve })
  const pending = draftAfterQueuedOperation('B', () => cleanup, () => current)
  current = 'C'
  release()
  assert.deepEqual(await pending, { newerDraft: 'C', error: null })
})

test('post-operation re-read preserves cleanup errors alongside the newest edit', async () => {
  const failure = new Error('cleanup failed')
  const result = await draftAfterQueuedOperation('B', async () => { throw failure }, () => 'C')
  assert.equal(result.newerDraft, 'C')
  assert.equal(result.error, failure)
})
