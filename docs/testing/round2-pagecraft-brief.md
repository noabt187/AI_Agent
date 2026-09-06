# PageCraft Task 2 implementation brief

User approved fix for round2 defects 3 and 7; implement within SAME DSH plugin at plugins/dsh-frontend-feedback. Do not change host files or other tasks. No subagents, no commits/staging/pushing. Use apply_patch. Existing plugin dirty changes are user-owned/previous work; preserve all. Root does host integration independently.

## Requirements

Implement browser-local durable unsaved source editor drafts (IndexedDB, no new runtime dependency), integrated with source-workspace.tsx. Storage key includes sessionId + canonical root from workspace response + selected folder + relative path; avoid cross-workspace/session leakage. Record base disk hash and draft revision/content. Persist on actual edits (not only unload). Restore when file is opened; same disk hash -> recovered dirty draft, different disk hash -> explicit conflict preserving draft and disk, never silently overwrite. Successful disk save clears only saved version, edits arriving during save remain dirty. Explicit discard removes that file's stored draft only. Closing workspaces/tabs/mode/session and refresh must not silently lose edits: durable restore + beforeunload for dirty or pending persistence, plus existing explicit close confirmation. Storage failures/quota errors visible; no false locally-saved status; limits to bound data. Sensitive filenames (.env/.env.*, private keys/credential files) must not be silently cached. Keep same package compatible with DSH; no AI Agent-specific APIs.

Support .gitignore, .gitattributes, .editorconfig, Dockerfile, Containerfile, LICENSE, Makefile as text where content is valid supported text. Retain existing size limit, binary/UTF-8 checks and path restrictions. Don't blanket allow all unknown or credential files. No mutations of trial repo; tests use generated temp fixtures.

## Files

Create src/client/source-drafts.ts with injectable storage interface and IndexedDB implementation for persistence; tests can use in-memory backend. Modify src/client/source-workspace.tsx, src/client/index.tsx only as needed for close/mode guard. Modify src/workspace.ts text detection, plugin tests. Regenerate lib via existing build. Do not edit root package files.

## Test cases

RED then GREEN: draft keyed by workspace/session/path; read after new cache instance; conflict after external hash change; clearing revision N preserves N+1; failure produces warning; explicit discard doesn't affect other draft. React integration if feasible, else browser root verifies wiring. Filename tests: .gitignore/LICENSE valid UTF-8 read/write, binary content named LICENSE refused, no accidental .env/private-key caching. Existing plugin suite must still pass.

Run `npm --prefix plugins/dsh-frontend-feedback run check` once final. Report detailed changes/tests/concerns to docs/testing/round2-pagecraft-implementation.md, short completion to root. Never claim browser acceptance (root handles). Include a unified diff file for your own Task 2 changes, excluding generated bundles, in docs/testing/round2-pagecraft.diff (baseline is state at task start, not git HEAD).
