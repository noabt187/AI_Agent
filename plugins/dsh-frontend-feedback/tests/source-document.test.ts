import assert from 'node:assert/strict'
import test from 'node:test'
import { createSourceDocument, editSourceDocument, resetSourceDocument, documentVersion, sameDocumentVersion, sourceDocumentRaw, sourceDocumentDirty, recoverSourceDocument } from '../src/client/source-document.ts'

const scope = { sessionId: 'a', rootPath: '/repo', selectedFolder: '.', path: 'file.txt' }
const file = { path: 'file.txt', content: '\uFEFFa\r\n', hash: 'disk', bytes: 6, updatedAt: '', language: 'text' }
test('document versions reject ABA edits, resets, reopen and scope changes', () => {
  const doc = createSourceDocument(scope, file)
  const version = documentVersion(doc)
  const aba = editSourceDocument(editSourceDocument(doc, 'changed'), doc.draft)
  assert.equal(sameDocumentVersion(aba, version), false)
  assert.equal(sameDocumentVersion(resetSourceDocument(doc, file), version), false)
  assert.equal(sameDocumentVersion(createSourceDocument(scope, file), version), false)
  assert.equal(sameDocumentVersion(createSourceDocument({ ...scope, sessionId: 'b' }, file), version), false)
  assert.equal(sourceDocumentDirty(aba), false)
  assert.equal(sourceDocumentRaw(aba), file.content)
})
test('mixed documents preserve original raw content and reject edits', () => {
  const doc = createSourceDocument(scope, { ...file, content: 'a\r\nb\nc' })
  assert.equal(doc.format.eol, 'mixed')
  assert.equal(sourceDocumentRaw(doc), 'a\r\nb\nc')
  assert.equal(editSourceDocument(doc, 'changed'), doc)
})

test('legacy mixed draft keeps its own raw bytes and a mixed disk remains read-only', () => {
  const doc = createSourceDocument(scope, file)
  const recovered = recoverSourceDocument(doc, { kind: 'conflict', content: 'a\r\nb\nc', baseHash: 'old', diskHash: file.hash, revision: 1 })
  assert.equal(sourceDocumentRaw(recovered), 'a\r\nb\nc')
  const mixedDisk = createSourceDocument(scope, { ...file, content: 'a\r\nb\nc' })
  const mixedRecovered = recoverSourceDocument(mixedDisk, { kind: 'recovered', content: 'legacy\n', revision: 1 })
  assert.equal(editSourceDocument(mixedRecovered, 'changed'), mixedRecovered)
  assert.equal(sourceDocumentRaw(mixedRecovered), 'legacy\n')
})
