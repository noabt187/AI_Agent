import { basicSetup } from 'codemirror'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import { useLayoutEffect, useRef } from 'react'
import type { ReactElement } from 'react'

const externalChange = Annotation.define<boolean>()
function language(path: string) {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  if (ext === '.json') return json()
  if (ext === '.css') return css()
  if (ext === '.html' || ext === '.htm') return html()
  if (ext === '.md' || ext === '.markdown') return markdown()
  return javascript({ jsx: ext === '.jsx' || ext === '.tsx', typescript: ext === '.ts' || ext === '.tsx' })
}

export interface CodeEditorProps {
  documentId: string
  path: string
  value: string
  resetRevision: number
  readOnly: boolean
  revealLine?: number
  onChange(value: string): void
  onSave(): void
}

export function CodeEditor(props: CodeEditorProps): ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const current = useRef(props)
  current.current = props
  const reset = useRef(props.resetRevision)
  const editable = useRef(new Compartment())
  const extensions = () => [
    basicSetup, language(current.current.path), oneDark,
    editable.current.of([EditorState.readOnly.of(current.current.readOnly), EditorView.editable.of(!current.current.readOnly)]),
    keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { if (!current.current.readOnly) current.current.onSave(); return true } }]),
    EditorView.updateListener.of(update => {
      if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalChange))) {
        current.current.onChange(update.state.doc.toString())
      }
    }),
    EditorView.theme({ '&': { height: '100%', fontSize: '12px' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'JetBrains Mono, Consolas, ui-monospace, monospace' }, '.cm-content': { padding: '12px 0' } }),
  ]
  useLayoutEffect(() => {
    if (host.current === null) return
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: current.current.value, extensions: extensions() }) })
    viewRef.current = view
    reset.current = current.current.resetRevision
    return () => { view.destroy(); viewRef.current = null }
  }, [props.documentId])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (view === null) return
    if (reset.current !== props.resetRevision) {
      // A fresh state clears history while retaining the same mounted view.
      view.setState(EditorState.create({ doc: props.value, extensions: extensions() }))
      reset.current = props.resetRevision
    } else if (view.state.doc.toString() !== props.value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value }, annotations: [externalChange.of(true), Transaction.addToHistory.of(false)] })
    }
  }, [props.documentId, props.value, props.resetRevision])

  useLayoutEffect(() => {
    viewRef.current?.dispatch({ effects: editable.current.reconfigure([EditorState.readOnly.of(props.readOnly), EditorView.editable.of(!props.readOnly)]) })
  }, [props.documentId, props.readOnly])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (view === null || props.revealLine === undefined) return
    const line = view.state.doc.line(Math.min(view.state.doc.lines, Math.max(1, props.revealLine)))
    view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) })
  }, [props.documentId, props.revealLine])
  return <div ref={host} style={{ height: '100%', minHeight: 0 }} />
}
