import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { undo } from '@codemirror/commands'
import { CodeEditor } from '../src/client/CodeEditor.tsx'
import { installBrowserDom } from './helpers/browser-dom.ts'

test('controlled editor echoes preserve view, selection and undo; resets clear history without change feedback', async () => {
  const dom = installBrowserDom()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let value = 'base\nline two'
  let changes = 0
  let saves = 0
  let resetRevision = 0
  const render = (revealLine?: number) => root.render(<CodeEditor documentId="doc" path="file.txt" value={value} resetRevision={resetRevision} readOnly={false} revealLine={revealLine} onChange={next => { value = next; changes++; render() }} onSave={() => { saves++ }} />)
  try {
    await act(async () => render())
    const view = EditorView.findFromDOM(host.querySelector('.cm-content')!)!
    await act(async () => view.dispatch({ changes: { from: 0, insert: 'x' }, selection: { anchor: 1 } }))
    assert.equal(EditorView.findFromDOM(host.querySelector('.cm-content')!), view)
    assert.equal(view.state.selection.main.anchor, 1)
    assert.equal(changes, 1)
    view.scrollDOM.scrollTop = 99
    await act(async () => render())
    assert.equal(view.scrollDOM.scrollTop, 99)
    assert.equal(view.state.selection.main.anchor, 1)
    await act(async () => render(2))
    assert.equal(view.state.doc.toString(), 'xbase\nline two')
    await act(async () => { undo(view) })
    assert.equal(value, 'base\nline two')
    await act(async () => view.dispatch({ changes: { from: 0, insert: 'discarded' } }))
    const beforeReset = changes
    value = 'disk\nnext'
    resetRevision++
    await act(async () => render())
    assert.equal(view.state.doc.toString(), value)
    assert.equal(changes, beforeReset)
    await act(async () => { undo(view) })
    assert.equal(view.state.doc.toString(), 'disk\nnext')
    await act(async () => view.dispatch({ changes: { from: 0, insert: 'fresh' } }))
    assert.equal(value, 'freshdisk\nnext')
    await act(async () => view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true })))
    assert.equal(saves, 1)
  } finally { await act(async () => root.unmount()); dom.cleanup() }
})
