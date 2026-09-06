import type { WorkspaceFile } from '../workspace.ts'
import { sourceDraftKey } from './source-drafts.ts'
import type { SourceDraftScope, DraftRestore } from './source-drafts.ts'
import { decodeSourceText, encodeSourceText } from './text-format.ts'
import type { TextFormat } from './text-format.ts'

export interface SourceDocument {
  readonly documentId: string
  readonly scope: SourceDraftScope
  readonly editRevision: number
  readonly resetRevision: number
  readonly file: WorkspaceFile
  readonly draft: string
  readonly rawDraft: string
  readonly format: TextFormat
  readonly conflict: WorkspaceFile | null
  readonly conflictRevision: number
  readonly draftRevision: number | null
}

export interface DocumentVersion {
  documentId: string
  editRevision: number
  resetRevision: number
  baseHash: string
  cacheRevision: number | null
  conflictRevision: number
}

let generation = 0
export function createSourceDocument(scope: SourceDraftScope, file: WorkspaceFile): SourceDocument {
  const parsed = decodeSourceText(file.content)
  return { documentId: `${sourceDraftKey(scope)}:${++generation}`, scope: { ...scope }, file, draft: parsed.text, rawDraft: file.content, format: parsed.format, editRevision: 0, resetRevision: 0, conflict: null, conflictRevision: 0, draftRevision: null }
}

export function sourceDocumentRaw(doc: SourceDocument): string {
  return doc.format.eol === 'mixed' ? doc.rawDraft : encodeSourceText(doc.draft, doc.format)
}

export function sourceDocumentReadOnly(doc: SourceDocument): boolean {
  return doc.format.eol === 'mixed' || decodeSourceText(doc.file.content).format.eol === 'mixed'
}

export function recoverSourceDocument(doc: SourceDocument, restored: DraftRestore): SourceDocument {
  if (restored.kind === 'none') return doc
  const parsed = decodeSourceText(restored.content)
  return observeSourceConflict({
    ...doc, draft: parsed.text, rawDraft: restored.content,
    format: parsed.format.eol === 'mixed' ? parsed.format : restored.format ?? (restored.kind === 'recovered' ? doc.format : parsed.format),
    draftRevision: restored.revision,
  }, restored.kind === 'conflict' ? doc.file : null)
}

// Observations have their own revision: disk B -> C -> B still invalidates a pending replacement.
export function observeSourceConflict(doc: SourceDocument, conflict: WorkspaceFile | null): SourceDocument {
  if (doc.conflict?.hash === conflict?.hash) return doc
  return { ...doc, conflict, conflictRevision: doc.conflictRevision + 1 }
}

export function sourceDocumentDirty(doc: SourceDocument): boolean {
  return sourceDocumentRaw(doc) !== doc.file.content
}

export function editSourceDocument(doc: SourceDocument, draft: string): SourceDocument {
  if (sourceDocumentReadOnly(doc) || doc.draft === draft) return doc
  return { ...doc, draft, editRevision: doc.editRevision + 1 }
}

export function resetSourceDocument(doc: SourceDocument, file: WorkspaceFile): SourceDocument {
  const parsed = decodeSourceText(file.content)
  return observeSourceConflict({ ...doc, file, draft: parsed.text, rawDraft: file.content, format: parsed.format, resetRevision: doc.resetRevision + 1, draftRevision: null }, null)
}

export function documentVersion(doc: SourceDocument): DocumentVersion {
  return { documentId: doc.documentId, editRevision: doc.editRevision, resetRevision: doc.resetRevision, baseHash: doc.file.hash, cacheRevision: doc.draftRevision, conflictRevision: doc.conflictRevision }
}

// Cache completion is allowed to advance cacheRevision without invalidating text operations.
export function sameDocumentVersion(doc: SourceDocument | undefined, version: DocumentVersion, allowEdits = false): boolean {
  return doc !== undefined && doc.documentId === version.documentId && doc.resetRevision === version.resetRevision
    && doc.file.hash === version.baseHash && (allowEdits || doc.editRevision === version.editRevision)
}

export function sameDocumentReplacementVersion(doc: SourceDocument | undefined, version: DocumentVersion, allowEdits = false): boolean {
  return sameDocumentVersion(doc, version, allowEdits) && doc!.conflictRevision === version.conflictRevision
}
