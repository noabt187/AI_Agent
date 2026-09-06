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
  readonly draftRevision: number | null
}

export interface DocumentVersion {
  documentId: string
  editRevision: number
  resetRevision: number
  baseHash: string
  cacheRevision: number | null
}

let generation = 0
export function createSourceDocument(scope: SourceDraftScope, file: WorkspaceFile): SourceDocument {
  const parsed = decodeSourceText(file.content)
  return { documentId: `${sourceDraftKey(scope)}:${++generation}`, scope: { ...scope }, file, draft: parsed.text, rawDraft: file.content, format: parsed.format, editRevision: 0, resetRevision: 0, conflict: null, draftRevision: null }
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
  return {
    ...doc, draft: parsed.text, rawDraft: restored.content,
    format: parsed.format.eol === 'mixed' ? parsed.format : restored.format ?? (restored.kind === 'recovered' ? doc.format : parsed.format),
    conflict: restored.kind === 'conflict' ? doc.file : null, draftRevision: restored.revision,
  }
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
  return { ...doc, file, draft: parsed.text, rawDraft: file.content, format: parsed.format, resetRevision: doc.resetRevision + 1, draftRevision: null, conflict: null }
}

export function documentVersion(doc: SourceDocument): DocumentVersion {
  return { documentId: doc.documentId, editRevision: doc.editRevision, resetRevision: doc.resetRevision, baseHash: doc.file.hash, cacheRevision: doc.draftRevision }
}

// Cache completion is allowed to advance cacheRevision without invalidating text operations.
export function sameDocumentVersion(doc: SourceDocument | undefined, version: DocumentVersion, allowEdits = false): boolean {
  return doc !== undefined && doc.documentId === version.documentId && doc.resetRevision === version.resetRevision
    && doc.file.hash === version.baseHash && (allowEdits || doc.editRevision === version.editRevision)
}
