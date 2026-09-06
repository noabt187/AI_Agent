import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { undo } from '@codemirror/commands'
import { IDBFactory } from 'fake-indexeddb'
import { WorkspaceExplorer } from '../src/client/source-workspace.tsx'
import { IndexedDbDraftStorage, sourceDraftKey } from '../src/client/source-drafts.ts'
import { installBrowserDom } from './helpers/browser-dom.ts'

const scope = { sessionId: 'test', rootPath: '/fixture', selectedFolder: '.', path: 'source.txt' }
function snapshot(content: string, path = 'source.txt') {
  return { path, content, hash: `hash:${content}`, bytes: new TextEncoder().encode(content).length, updatedAt: '', language: 'text' }
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) }) }
async function mountWorkspace(t: any, raw = 'base\n', legacy?: { content: string; baseHash: string }) {
  const dom = installBrowserDom()
  const idb = new IDBFactory()
  const storage = new IndexedDbDraftStorage(idb)
  if (legacy) await storage.put({ ...scope, ...legacy, key: sourceDraftKey(scope), revision: 1, updatedAt: 0 })
  Object.defineProperty(window, 'indexedDB', { configurable: true, value: idb })
  const oldFetch = globalThis.fetch
  const oldEvents = globalThis.EventSource
  globalThis.EventSource = class { addEventListener() {} close() {} } as any
  let disk = snapshot(raw)
  let putGate: Promise<void> | undefined
  let readGate: Promise<void> | undefined
  let restoreGate: Promise<void> | undefined
  let writes = 0
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://fixture')
    if (url.pathname.endsWith('/directory')) return Response.json(['source.txt', 'other.txt'].map(path => ({ path, name: path, kind: 'file', textEditable: true, imagePreviewable: false, updatedAt: '' })))
    if (url.pathname.endsWith('/file')) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        writes++
        await putGate
        if (body.baseHash !== disk.hash) return Response.json({ error: { code: 'WORKSPACE_FILE_CONFLICT', message: 'conflict', details: { current: disk } } }, { status: 409 })
        disk = snapshot(body.content)
      } else {
        const result = url.searchParams.get('path') === 'other.txt' ? snapshot('other\n', 'other.txt') : disk
        await readGate
        return Response.json(result)
      }
      return Response.json(disk)
    }
    if (url.pathname.endsWith('/history')) return Response.json([{ id: 'old', path: 'source.txt', createdAt: '', hash: 'old', bytes: 4 }])
    if (url.pathname.endsWith('/restore')) { await restoreGate; disk = snapshot('history\n'); return Response.json(disk) }
    return Response.json({ rootPath: scope.rootPath, selectedPath: scope.rootPath, selectedFolder: '.', watcher: 'connected', sequence: 0 })
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const render = (sessionId = 'test') => root.render(<WorkspaceExplorer sessionId={sessionId} previewSrc={null} onClose={() => {}} onRefresh={() => {}} onNavigate={() => {}} onAnnotationSelection={() => {}} />)
  await act(async () => render())
  await settle()
  const click = async (label: string) => {
    const button = Array.from(host.querySelectorAll('button')).find(button => button.textContent === label || button.title === label)
    assert.ok(button, `button ${label} exists`)
    await act(async () => button.click())
    await settle()
  }
  await click('source.txt')
  const view = () => EditorView.findFromDOM(host.querySelector('.cm-content')!)!
  const edit = async (insert: string) => { await act(async () => view().dispatch({ changes: { from: view().state.doc.length, insert } })); await settle() }
  const saveButton = () => Array.from(host.querySelectorAll('header button')).find(button => /保存|处理中/.test(button.textContent!)) as HTMLButtonElement
  t.after(async () => { await act(async () => root.unmount()); globalThis.fetch = oldFetch; globalThis.EventSource = oldEvents; dom.cleanup() })
  return { host, click, view, edit, saveButton, storage, key: sourceDraftKey(scope), disk: () => disk, writes: () => writes, setDisk: (raw: string) => { disk = snapshot(raw) }, setPutGate: (gate?: Promise<void>) => { putGate = gate }, setReadGate: (gate?: Promise<void>) => { readGate = gate }, setRestoreGate: (gate?: Promise<void>) => { restoreGate = gate }, render }
}

test('real editor discard resets text, dirty state, cache and undo; next input cannot resurrect it', async t => {
  const f = await mountWorkspace(t)
  await f.edit('R3-DISCARD')
  assert.equal(f.saveButton().disabled, false)
  assert.ok(await f.storage.get(f.key))
  await f.click('丢弃修改')
  assert.equal(f.view().state.doc.toString().includes('R3-DISCARD'), false)
  assert.equal(f.saveButton().disabled, true)
  assert.equal(await f.storage.get(f.key), undefined)
  await act(async () => { undo(f.view()) })
  assert.equal(f.view().state.doc.toString().includes('R3-DISCARD'), false)
  await f.edit('new')
  assert.equal(f.view().state.doc.toString(), 'base\nnew')
})

test('real CRLF editor input then undo returns to clean', async t => {
  const f = await mountWorkspace(t, '中文\r\n😀\r\n')
  await f.edit('x')
  await act(async () => { undo(f.view()) })
  await settle()
  assert.equal(f.saveButton().disabled, true)
  assert.equal(await f.storage.get(f.key), undefined)
})

for (const eol of ['\n', '\r\n', '\r']) {
  test(`real editor saves homogeneous ${JSON.stringify(eol)} with BOM and without adding a trailing newline`, async t => {
    const f = await mountWorkspace(t, `\uFEFF中文${eol}😀`)
    await f.edit(' changed')
    await f.click('保存 Ctrl+S')
    assert.equal(f.disk().content, `\uFEFF中文${eol}😀 changed`)
    assert.equal(f.host.querySelector('.cm-content')?.textContent, '中文😀 changed')
    assert.equal(f.saveButton().disabled, true)
    await act(async () => { undo(f.view()) })
    await settle()
    assert.equal(f.saveButton().disabled, false)
  })
}

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

test('discard ABA edit during controlled cache deletion retains text and latest cached revision', async t => {
  const f = await mountWorkspace(t)
  await f.edit('A')
  const gate = deferred()
  const original = IndexedDbDraftStorage.prototype.delete
  IndexedDbDraftStorage.prototype.delete = async function (key) { await gate.promise; return original.call(this, key) }
  t.after(() => { IndexedDbDraftStorage.prototype.delete = original })
  await f.click('丢弃修改')
  await f.edit('B')
  await act(async () => f.view().dispatch({ changes: { from: f.view().state.doc.length - 1, to: f.view().state.doc.length } }))
  await act(async () => gate.resolve())
  await settle()
  assert.equal(f.view().state.doc.toString(), 'base\nA')
  assert.equal(f.saveButton().disabled, false)
  assert.equal((await f.storage.get(f.key))?.content, 'base\nA')
  assert.match(f.host.textContent!, /新修改已保留/)
})

test('failed discard retains real editor, dirty status and durable draft', async t => {
  const f = await mountWorkspace(t)
  await f.edit('keep')
  const original = IndexedDbDraftStorage.prototype.delete
  IndexedDbDraftStorage.prototype.delete = async () => { throw new Error('delete denied') }
  t.after(() => { IndexedDbDraftStorage.prototype.delete = original })
  await f.click('丢弃修改')
  assert.equal(f.view().state.doc.toString(), 'base\nkeep')
  assert.equal(f.saveButton().disabled, false)
  assert.equal((await f.storage.get(f.key))?.content, 'base\nkeep')
  assert.match(f.host.textContent!, /无法丢弃.*delete denied/)
})

test('save with a later edit keeps view/history and rebases the latest raw BOM CRLF cache', async t => {
  const f = await mountWorkspace(t, '\uFEFFbase\r\n')
  await f.edit('saved')
  const view = f.view()
  const gate = deferred()
  f.setPutGate(gate.promise)
  await f.click('保存 Ctrl+S')
  await f.edit('latest')
  await act(async () => gate.resolve())
  await settle()
  assert.equal(f.disk().content, '\uFEFFbase\r\nsaved')
  assert.equal(f.view(), view)
  assert.equal(view.state.doc.toString(), 'base\nsavedlatest')
  assert.equal(f.saveButton().disabled, false)
  const cached = await f.storage.get(f.key)
  assert.equal(cached?.content, '\uFEFFbase\r\nsavedlatest')
  assert.equal(cached?.baseHash, f.disk().hash)
  assert.deepEqual(cached?.format, { eol: 'crlf', bom: true })
  await act(async () => { undo(view) })
  assert.notEqual(view.state.doc.toString(), 'base\nsavedlatest')
})

test('save ABA edit keeps undo history and clears clean cache', async t => {
  const f = await mountWorkspace(t)
  await f.edit('A')
  const view = f.view()
  const gate = deferred()
  f.setPutGate(gate.promise)
  await f.click('保存 Ctrl+S')
  await f.edit('B')
  await act(async () => view.dispatch({ changes: { from: view.state.doc.length - 1, to: view.state.doc.length } }))
  await act(async () => gate.resolve())
  await settle()
  assert.equal(f.view(), view)
  assert.equal(f.view().state.doc.toString(), 'base\nA')
  assert.equal(f.saveButton().disabled, true)
  assert.equal(await f.storage.get(f.key), undefined)
})

test('save cache cleanup failure reports disk success separately and retains later edits', async t => {
  const f = await mountWorkspace(t)
  await f.edit('saved')
  const original = IndexedDbDraftStorage.prototype.deleteIfRevision
  const gate = deferred()
  IndexedDbDraftStorage.prototype.deleteIfRevision = async () => { await gate.promise; throw new Error('cleanup denied') }
  t.after(() => { IndexedDbDraftStorage.prototype.deleteIfRevision = original })
  await f.click('保存 Ctrl+S')
  await f.edit('new')
  await act(async () => gate.resolve())
  await settle()
  assert.equal(f.disk().content, 'base\nsaved')
  assert.equal(f.view().state.doc.toString(), 'base\nsavednew')
  assert.equal(f.saveButton().disabled, false)
  assert.match(f.host.textContent!, /磁盘已保存，但浏览器草稿清理失败/)
})

test('external disk write during save opens conflict, accepts disk through reset and clears cache/history', async t => {
  const f = await mountWorkspace(t)
  await f.edit('mine')
  const gate = deferred()
  f.setPutGate(gate.promise)
  await f.click('保存 Ctrl+S')
  f.setDisk('external\r\n')
  await act(async () => gate.resolve())
  await settle()
  assert.match(f.host.textContent!, /文件已被 Agent/)
  assert.equal(f.view().state.doc.toString(), 'base\nmine')
  await f.click('载入最新版本')
  assert.equal(f.view().state.doc.toString(), 'external\n')
  assert.equal(f.saveButton().disabled, true)
  assert.equal(await f.storage.get(f.key), undefined)
  await act(async () => { undo(f.view()) })
  assert.equal(f.view().state.doc.toString(), 'external\n')
})

test('stale refresh cannot replace a newer save and tab switches cannot misdirect conflict overwrite', async t => {
  const f = await mountWorkspace(t)
  const gate = deferred()
  f.setReadGate(gate.promise)
  await f.click('刷新目录')
  await f.edit('saved')
  await f.click('保存 Ctrl+S')
  await act(async () => gate.resolve())
  await settle()
  assert.equal(f.view().state.doc.toString(), 'base\nsaved')
  assert.equal(f.saveButton().disabled, true)
  f.setReadGate(undefined)
  await f.edit('mine')
  f.setDisk('external\n')
  await f.click('保存 Ctrl+S')
  await f.click('other.txt')
  await f.click('用我的版本覆盖')
  assert.equal(f.disk().content, 'base\nsavedmine')
  assert.equal(f.view().state.doc.toString(), 'other\n')
})

test('reopened document ignores the response for an earlier instance of the same path', async t => {
  const f = await mountWorkspace(t)
  await f.edit('saved')
  const gate = deferred()
  f.setPutGate(gate.promise)
  await f.click('保存 Ctrl+S')
  const close = f.host.querySelector('[aria-label="关闭 source.txt"]') as HTMLElement
  await act(async () => close.click())
  await f.click('source.txt')
  await f.edit('new instance')
  await act(async () => gate.resolve())
  await settle()
  assert.equal(f.view().state.doc.toString(), 'base\nsavednew instance')
  assert.equal(f.saveButton().disabled, false)
})

test('legacy matching draft inherits disk CRLF/BOM; legacy hash mismatch remains conflict', async t => {
  const raw = '\uFEFFbase\r\n'
  const f = await mountWorkspace(t, raw, { content: 'legacy\n', baseHash: `hash:${raw}` })
  assert.equal(f.view().state.doc.toString(), 'legacy\n')
  await f.click('保存 Ctrl+S')
  assert.equal(f.disk().content, '\uFEFFlegacy\r\n')
})

test('legacy mismatch does not silently replace a changed disk version', async t => {
  const f = await mountWorkspace(t, 'new disk\n', { content: 'old draft\n', baseHash: 'old hash' })
  assert.match(f.host.textContent!, /文件已被 Agent/)
  assert.equal(f.view().state.doc.toString(), 'old draft\n')
  assert.equal(f.writes(), 0)
})

test('mixed endings are visibly read-only and never produce a save request', async t => {
  const f = await mountWorkspace(t, 'a\r\nb\nc')
  assert.equal(f.host.querySelector('.cm-content')?.getAttribute('contenteditable'), 'false')
  assert.match(f.host.textContent!, /不自动统一混合换行/)
  assert.equal(f.saveButton().disabled, true)
  assert.equal(f.disk().content, 'a\r\nb\nc')
  assert.equal(f.writes(), 0)
})

test('history restore resets actual content and history plus the cache', async t => {
  const f = await mountWorkspace(t)
  await f.edit('old edit')
  await f.click('历史版本')
  const restore = Array.from(f.host.querySelectorAll('button')).find(button => button.textContent?.includes('Invalid Date'))!
  assert.ok(restore)
  await act(async () => restore.click())
  await settle()
  assert.equal(f.view().state.doc.toString(), 'history\n')
  assert.equal(f.saveButton().disabled, true)
  assert.equal(await f.storage.get(f.key), undefined)
  await act(async () => { undo(f.view()) })
  assert.equal(f.view().state.doc.toString(), 'history\n')
})

test('history restore with new edit retains that edit and rebases its cache', async t => {
  const f = await mountWorkspace(t)
  await f.edit('old edit')
  await f.click('历史版本')
  const gate = deferred()
  f.setRestoreGate(gate.promise)
  const restore = Array.from(f.host.querySelectorAll('button')).find(button => button.textContent?.includes('Invalid Date'))!
  await act(async () => restore.click())
  await f.edit('new edit')
  await act(async () => gate.resolve())
  await settle()
  assert.equal(f.view().state.doc.toString(), 'base\nold editnew edit')
  assert.equal(f.saveButton().disabled, false)
  assert.equal((await f.storage.get(f.key))?.baseHash, 'hash:history\n')
})

test('a session switch isolates late save from the same path in the new scope', async t => {
  const f = await mountWorkspace(t)
  await f.edit('old')
  const gate = deferred()
  f.setPutGate(gate.promise)
  await f.click('保存 Ctrl+S')
  await act(async () => f.render('new-session'))
  await settle()
  await f.click('source.txt')
  await f.edit('new')
  await act(async () => gate.resolve())
  await settle()
  assert.equal(f.view().state.doc.toString(), 'base\nnew')
  assert.equal(f.saveButton().disabled, false)
  const key = sourceDraftKey({ ...scope, sessionId: 'new-session' })
  assert.equal((await f.storage.get(key))?.content, 'base\nnew')
})
