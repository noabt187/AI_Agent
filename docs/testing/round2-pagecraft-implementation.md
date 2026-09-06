# PageCraft Round 2 — Task 2 implementation report

## Scope and baseline

- Implemented only in `plugins/dsh-frontend-feedback` plus the two required report artifacts under `docs/testing`.
- Captured a task-start copy of the plugin `src` and `tests` trees before editing. The accompanying `round2-pagecraft.diff` compares against that snapshot, not Git HEAD, so earlier dirty plugin work is excluded.
- Did not edit host/root package files, stage, commit, push, or mutate a trial repository.
- `src/client/index.tsx` did not require a Task 2 change: durable restoration survives its workspace/mode/session unmounts, while the source workspace retains its existing explicit close confirmations.

## Implementation

- Added `src/client/source-drafts.ts`:
  - injectable async storage contract;
  - IndexedDB implementation (`dsh-pagecraft-source-drafts`, `drafts` object store), with no new dependency;
  - in-memory implementation for deterministic tests;
  - keys composed from session ID, canonical workspace root, selected folder, and relative path;
  - disk base hash, monotonically increasing draft revision, content, and update timestamp;
  - compare-by-revision deletion so clearing saved revision N cannot remove N+1;
  - all persist, revision-clear, explicit-discard, and restore operations serialized per key, preventing a pending write from resurrecting a discarded draft;
  - IndexedDB operations resolve only after transaction completion and reject transaction error/abort even if the individual request had succeeded;
  - 1 MB per-draft limit and a non-evicting 100-draft global bound: creating draft 101 fails visibly while edits to existing records remain allowed;
  - sensitive-name exclusion on both persist and restore for `.env` variants, private keys/key stores, and separator-delimited credential, secret, client-secret, private-key, API-key, and service-account names.
- Integrated durable drafts into `src/client/source-workspace.tsx`:
  - every actual editor change schedules IndexedDB persistence;
  - opening a file restores a matching-base draft as dirty;
  - a changed disk hash opens an explicit two-sided conflict preserving both draft and disk content;
  - storage/quota/read/cleanup failures are shown in the existing status area and never described as locally saved;
  - successful disk saves clear only the saved revision;
  - edits made while a disk save is in flight remain dirty and are re-persisted against the new disk hash;
  - after revision cleanup awaits, the save path re-reads the live editor ref before re-persisting, so a B→C edit during cleanup cannot be overwritten by stale B;
  - persistence cleanup/re-persist warnings take precedence over the normal disk-save success message, while successful saves with newer edits explicitly remain dirty;
  - explicit “丢弃修改” and “载入最新版本” actions remove only that file's stored draft; discard is marked busy and re-reads live state after queued deletion so edits typed during the await remain dirty/durable rather than being reset;
  - `beforeunload` warns while any editor is dirty or persistence is pending;
  - existing tab/workspace close confirmation remains in place, while closing/unmounting does not delete durable drafts.
- Expanded supported text basenames in `src/workspace.ts`: `.gitignore`, `.gitattributes`, `.editorconfig`, `Dockerfile`, `Containerfile`, `LICENSE`, and `Makefile`.
- Hardened `readWorkspaceFile` in `src/workspace-explorer.ts` with fatal UTF-8 decoding. Existing size, path, and NUL/binary checks remain; invalid UTF-8 under an allowed basename is refused.
- Regenerated `lib/client.js` and `lib/index.js` through the existing build. Generated bundles are intentionally excluded from the supplied task-only source diff.

## TDD and verification

RED was observed first: `node --import tsx --test tests/source-drafts.test.ts` failed with `ERR_MODULE_NOT_FOUND` before `source-drafts.ts` existed.

Targeted GREEN run:

`node --import tsx --test tests/source-drafts.test.ts tests/workspace-contracts.test.ts tests/workspace-explorer.test.ts`

- Initial targeted run passed 13 tests; the first focused review-regression run passed 11 tests; the final cleanup-race focused run passed 13 tests. All had 0 failures.
- Covers key isolation/canonical root, restoration through a new cache instance, external-hash conflict, revision-safe clearing, visible storage failure result, file-scoped discard, sensitive-name exclusion, supported extensionless names, and invalid UTF-8/binary refusal using generated temporary fixtures.

Required final command (run once after implementation):

`npm --prefix plugins/dsh-frontend-feedback run check`

- Build passed.
- Full plugin suite passed after the final race fix: 67 tests, 0 failed.
- `npm pack --dry-run` passed; 8 files in the package preview.

## Remaining browser verification / concerns

- Browser acceptance was not claimed or performed here; root owns it per the brief. Recommended checks are reload recovery, switching PageCraft mode and back, closing/reopening a tab, IndexedDB quota/error messaging, restored conflict choices, and typing during an intentionally delayed PUT.
- Sensitive files remain editable when the server already classifies their extension as supported, but their drafts are deliberately not durable; the UI warns on each edit and `beforeunload` still guards dirty state.
- Draft limits are deliberately conservative (1 MB each, 100 records) beneath the existing 2 MB disk-editor limit. The implementation never evicts an unsaved draft to make room: oversized/new-over-capacity drafts remain in memory and produce a visible warning, but cannot be promised durable across refresh.

## Artifacts

- Implementation report: `docs/testing/round2-pagecraft-implementation.md`
- Task-start unified source/test diff (generated bundles excluded): `docs/testing/round2-pagecraft.diff`
