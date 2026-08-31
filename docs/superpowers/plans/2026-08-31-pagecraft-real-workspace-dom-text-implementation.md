# PageCraft Real Workspace and Direct DOM Text Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PageCraft's manifest-shaped source browser with a real session-scoped file workspace, keep it synchronized with disk, and add safe programmatic DOM-text-to-source editing with browser verification and rollback.

**Architecture:** The DSH host plugin remains the only file-system authority. A new generic workspace service validates paths under the session `cwd`, provides lazy directory and file APIs, and streams coalesced invalidation events over SSE; the React client renders the real tree and protects dirty buffers. Direct text editing uses annotator evidence, a bounded static source resolver, and a two-phase write/verify transaction that rolls back when the live DOM does not show the requested text.

**Tech Stack:** TypeScript, Node.js 22+ `fs/promises` and `fs.watch`, DSH web-server/session APIs, React 18, CodeMirror 6, `@babel/parser`, `parse5`, `jsonc-parser`, Node test runner, esbuild.

**Spec:** `docs/superpowers/specs/2026-08-31-pagecraft-real-workspace-dom-text-design.md`

## Global Constraints

- Make no changes to the DeepSeek Harness source tree; all implementation stays in `plugins/dsh-frontend-feedback`.
- The current DSH session `header.cwd` is the absolute security root; the client may select only that root or a descendant.
- Disk files are the source of truth. Do not create a virtual or regrouped file tree.
- `pagecraft-presentation.json` controls presentation data and asset bindings only; it never controls Explorer parent-child structure.
- Direct text edits never enqueue an Agent message and never consume model tokens.
- Write only a unique high-confidence source target; ambiguous, dynamic, external, generated, or out-of-folder text must remain unchanged.
- Every direct text write uses a base hash, atomic write, live-preview verification, and conditional rollback.
- Preserve the existing DOM annotation, area annotation, image-slot, presentation-generation, and shared feedback-queue behavior.
- Preserve user changes already present in the dirty working tree; stage only files named by each task.
- Keep files focused: generic workspace contracts in `workspace.ts`, disk operations in `workspace-explorer.ts`, watching in `workspace-watcher.ts`, source parsing/resolution in dedicated files, and presentation-only behavior outside those modules.
- Default limits: 2 MiB per editable text file, 2,000 indexed source files, 20 MiB total indexed text, 1.5 seconds resolver time budget, eight local import hops, 150 ms watcher batching, 8 seconds browser verification, and 2 minutes transaction retention.

---

## File structure

### New host/shared files

- `src/workspace.ts` — generic API paths, shared types, path/text/image classification, and client persistence keys.
- `src/workspace-explorer.ts` — safe real-folder listing, reads, mutations, atomic saves, history, metadata reconciliation.
- `src/workspace-watcher.ts` — one recursive watcher per selected root, subscriber fan-out, event batching, sequence tracking, cleanup.
- `src/source-text-parsers.ts` — source-position extraction for HTML-like markup, JS/TS/JSX/TSX, JSON, Markdown, Vue, and Svelte.
- `src/source-text-resolver.ts` — bounded project scan, local import/data-flow tracing, evidence scoring, and unique-target decision.
- `src/direct-text-edit.ts` — two-phase edit transaction, pending transaction retention, verification commit, and hash-safe rollback.

### New client files

- `src/client/workspace-state.ts` — pure lazy-tree cache and watcher-event reduction, enabling deterministic unit tests.
- `src/client/workspace.tsx` — real folder picker, Explorer, CodeMirror/image editor, preview column, conflict UI, direct text panel.

### Files to modify

- `src/index.ts` — register generic workspace, SSE, and direct-text routes; own service lifecycle; retain presentation asset routes.
- `src/shared.ts` — add text selection mode/evidence and runtime guards without changing feedback prompt payloads.
- `src/annotator-script.ts` — collect text evidence and answer post-refresh verification requests.
- `src/client/index.tsx` — share the annotation queue with the workspace preview, open the new workspace, and remove the old deck-only text edit path.
- `src/presentation-workspace.ts` — retain presentation manifest/asset contracts and remove generic file-workspace contracts.
- `src/source-workspace.ts` — progressively shed generic tree/file logic; at the final cleanup it contains presentation project migration/asset binding only and is renamed `src/presentation-project.ts`.
- `skills/presentation-builder/SKILL.md` — require stable editable text keys in generated slide markup.
- `README.md`, `README.zh-CN.md` — describe the real local workspace, automatic synchronization, and safe direct text boundaries.
- `package.json`, `package-lock.json` — add the three source parser dependencies.
- `tests/plugin.test.ts` — update route/bundle compatibility expectations and presentation regressions.

### New tests

- `tests/workspace-contracts.test.ts`
- `tests/workspace-explorer.test.ts`
- `tests/workspace-watcher.test.ts`
- `tests/workspace-state.test.ts`
- `tests/source-text-resolver.test.ts`
- `tests/direct-text-edit.test.ts`

---

### Task 1: Define generic workspace contracts

**Files:**
- Create: `plugins/dsh-frontend-feedback/src/workspace.ts`
- Create: `plugins/dsh-frontend-feedback/tests/workspace-contracts.test.ts`
- Modify: `plugins/dsh-frontend-feedback/src/index.ts` (exports only)
- Modify: `plugins/dsh-frontend-feedback/src/presentation-workspace.ts`

**Interfaces:**
- Consumes: current session IDs and existing `presentationSourceLanguage()` behavior.
- Produces: `normalizeWorkspacePath()`, `isWorkspaceTextFile()`, `workspaceLanguage()`, API constants, `WorkspaceSummary`, `WorkspaceEntry`, `WorkspaceFile`, `WorkspaceEvent`, `DomTextSelection`, `DirectTextEditStart`, and `DirectTextEditVerification`.

- [ ] **Step 1: Write the failing contract tests**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PAGECRAFT_WORKSPACE_DIRECTORY_PATH,
  PAGECRAFT_WORKSPACE_EVENTS_PATH,
  PAGECRAFT_WORKSPACE_TEXT_EDIT_PATH,
  isWorkspaceTextFile,
  normalizeWorkspacePath,
  workspaceFolderStorageKey,
} from '../lib/index.js'

test('workspace paths allow root and descendants but reject escape paths', () => {
  assert.equal(normalizeWorkspacePath('.'), '.')
  assert.equal(normalizeWorkspacePath('src\\slides'), 'src/slides')
  assert.equal(normalizeWorkspacePath('./src/slides'), 'src/slides')
  assert.equal(normalizeWorkspacePath('../secret'), null)
  assert.equal(normalizeWorkspacePath('D:\\secret'), null)
  assert.equal(normalizeWorkspacePath('/secret'), null)
  assert.equal(normalizeWorkspacePath('src//slides'), null)
})

test('workspace contracts cover frontend text and stable session storage', () => {
  for (const path of ['index.html', 'App.tsx', 'Slide.vue', 'Deck.svelte', 'copy.json', 'notes.mdx']) {
    assert.equal(isWorkspaceTextFile(path), true, path)
  }
  assert.equal(isWorkspaceTextFile('machine.png'), false)
  assert.equal(workspaceFolderStorageKey('D:\\project', 'session-1'), workspaceFolderStorageKey('D:\\project', 'session-1'))
  assert.notEqual(workspaceFolderStorageKey('D:\\project', 'session-1'), workspaceFolderStorageKey('D:\\other', 'session-1'))
  assert.equal(PAGECRAFT_WORKSPACE_DIRECTORY_PATH, '/api/frontend-feedback/workspace/directory')
  assert.equal(PAGECRAFT_WORKSPACE_EVENTS_PATH, '/api/frontend-feedback/workspace/events')
  assert.equal(PAGECRAFT_WORKSPACE_TEXT_EDIT_PATH, '/api/frontend-feedback/workspace/text-edit')
})
```

- [ ] **Step 2: Run the test and verify the missing exports fail**

Run:

```powershell
cd plugins/dsh-frontend-feedback
npm run build
node --import tsx --test tests/workspace-contracts.test.ts
```

Expected: FAIL because `normalizeWorkspacePath` and workspace API constants are not exported.

- [ ] **Step 3: Add the shared contracts**

Create `src/workspace.ts` with these exact public shapes:

```ts
export const PAGECRAFT_WORKSPACE_PATH = '/api/frontend-feedback/workspace'
export const PAGECRAFT_WORKSPACE_FOLDERS_PATH = '/api/frontend-feedback/workspace/folders'
export const PAGECRAFT_WORKSPACE_DIRECTORY_PATH = '/api/frontend-feedback/workspace/directory'
export const PAGECRAFT_WORKSPACE_FILE_PATH = '/api/frontend-feedback/workspace/file'
export const PAGECRAFT_WORKSPACE_BLOB_PATH = '/api/frontend-feedback/workspace/blob'
export const PAGECRAFT_WORKSPACE_ENTRY_PATH = '/api/frontend-feedback/workspace/entry'
export const PAGECRAFT_WORKSPACE_HISTORY_PATH = '/api/frontend-feedback/workspace/history'
export const PAGECRAFT_WORKSPACE_RESTORE_PATH = '/api/frontend-feedback/workspace/restore'
export const PAGECRAFT_WORKSPACE_EVENTS_PATH = '/api/frontend-feedback/workspace/events'
export const PAGECRAFT_WORKSPACE_TEXT_EDIT_PATH = '/api/frontend-feedback/workspace/text-edit'
export const PAGECRAFT_WORKSPACE_TEXT_VERIFY_PATH = '/api/frontend-feedback/workspace/text-verify'

export interface WorkspaceSummary {
  rootPath: string
  selectedFolder: string
  selectedPath: string
  watcher: 'connected' | 'degraded' | 'unavailable'
  sequence: number
}

export interface WorkspaceEntry {
  path: string
  name: string
  kind: 'file' | 'directory' | 'symlink'
  bytes?: number
  updatedAt: string
  textEditable: boolean
  imagePreviewable: boolean
}

export interface WorkspaceFile {
  path: string
  content: string
  hash: string
  bytes: number
  updatedAt: string
  language: string
}

export interface WorkspaceHistoryEntry {
  id: string
  path: string
  hash: string
  bytes: number
  createdAt: string
}

export interface WorkspaceEvent {
  sequence: number
  kind: 'invalidate' | 'rescan'
  paths: string[]
}

export interface DomTextSelection {
  pageUrl: string
  framePath: number[]
  selector: string
  fingerprint: string
  displayedText: string
  tagName: string
  attributes: Record<string, string>
  nearbyText: string[]
  slideId?: string
  textKey?: string
}

export interface DirectTextEditStart {
  transactionId: string
  path: string
  line: number
  previousText: string
  replacementText: string
  writtenHash: string
  expiresAt: string
}

export interface DirectTextEditVerification {
  transactionId: string
  verified: boolean
  observedText?: string
}

export interface DirectTextEditResult {
  status: 'committed' | 'rolled_back' | 'conflict'
  path: string
  line: number
  message: string
  file?: WorkspaceFile
}
```

Implement `normalizeWorkspacePath()` so `.` is the only root spelling and all other results are slash-normalized non-empty segments. Include `.vue`, `.svelte`, `.mdx`, `.yaml`, `.yml`, `.txt`, `.svg`, and the existing text extensions. Use a small deterministic browser-safe FNV-1a helper for `workspaceFolderStorageKey(rootPath, sessionId)` so absolute paths are not used verbatim as local-storage keys; do not import `node:crypto` into this shared client module.

Keep the legacy `PresentationWorkspaceFile`, `PresentationWorkspaceTreeEntry`, and `PresentationWorkspaceHistoryEntry` temporarily so the existing uncommitted source-workspace implementation continues to compile during incremental tasks. Remove those legacy contracts in Task 12 after every client and route has moved to the generic workspace types. Export the new workspace module from `src/index.ts`.

- [ ] **Step 4: Build and rerun the contract tests**

Run:

```powershell
npm run build
node --import tsx --test tests/workspace-contracts.test.ts
```

Expected: 2 tests PASS.

- [ ] **Step 5: Commit the contracts**

```powershell
git add plugins/dsh-frontend-feedback/src/workspace.ts plugins/dsh-frontend-feedback/src/presentation-workspace.ts plugins/dsh-frontend-feedback/src/index.ts plugins/dsh-frontend-feedback/tests/workspace-contracts.test.ts
git commit -m "refactor: define generic PageCraft workspace contracts"
```

---

### Task 2: Implement safe lazy folder browsing and exact disk listing

**Files:**
- Create: `plugins/dsh-frontend-feedback/src/workspace-explorer.ts`
- Create: `plugins/dsh-frontend-feedback/tests/workspace-explorer.test.ts`
- Modify: `plugins/dsh-frontend-feedback/src/index.ts` (exports only)

**Interfaces:**
- Consumes: `normalizeWorkspacePath()`, `WorkspaceSummary`, and `WorkspaceEntry` from Task 1.
- Produces: `WorkspaceExplorerError`, `readWorkspaceSummary()`, `listWorkspaceFolders()`, `listWorkspaceDirectory()`, and `resolveWorkspaceTarget()`.

- [ ] **Step 1: Write failing real-tree and security tests**

```ts
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  listWorkspaceDirectory,
  listWorkspaceFolders,
  readWorkspaceSummary,
} from '../lib/index.js'

test('real workspace listing preserves physical image directories', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'pagecraft-real-tree-'))
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(cwd, { recursive: true, force: true })))
  await mkdir(join(cwd, 'slides', 'assets'), { recursive: true })
  await mkdir(join(cwd, 'slides', 'present-assets'), { recursive: true })
  await writeFile(join(cwd, 'slides', 'assets', 'machine.png'), Buffer.from([137, 80, 78, 71]))
  await writeFile(join(cwd, 'slides', 'deck.json'), '{}\n')

  const entries = await listWorkspaceDirectory(cwd, 'slides', 'slides')
  assert.deepEqual(entries.map(entry => [entry.name, entry.kind]), [
    ['assets', 'directory'],
    ['present-assets', 'directory'],
    ['deck.json', 'file'],
  ])
  const assets = await listWorkspaceDirectory(cwd, 'slides', 'slides/assets')
  assert.deepEqual(assets.map(entry => entry.path), ['slides/assets/machine.png'])
})

test('folder browsing never crosses cwd or follows an escaping symlink', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'pagecraft-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'pagecraft-outside-'))
  t.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(cwd, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })
  await mkdir(join(cwd, 'safe'))
  await symlink(outside, join(cwd, 'safe', 'escape'), 'junction')

  assert.deepEqual((await listWorkspaceFolders(cwd, '.')).map(entry => entry.path), ['safe'])
  await assert.rejects(() => listWorkspaceDirectory(cwd, 'safe', 'safe/escape'), /符号链接/)
  await assert.rejects(() => readWorkspaceSummary(cwd, '../outside'), /路径/)
})
```

- [ ] **Step 2: Run the new tests and verify they fail**

Run:

```powershell
npm run build
node --import tsx --test tests/workspace-explorer.test.ts
```

Expected: FAIL because the Explorer functions are not exported.

- [ ] **Step 3: Implement root validation and lazy listing**

Create `workspace-explorer.ts` around one path authority:

```ts
export class WorkspaceExplorerError extends Error {
  override readonly name = 'WorkspaceExplorerError'

  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'WORKSPACE_ERROR',
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export interface ResolvedWorkspaceTarget {
  root: string
  selectedRoot: string
  target: string
  relativePath: string
}

export async function resolveWorkspaceTarget(
  cwd: string,
  selectedFolder: unknown,
  path: unknown,
  mustExist: boolean,
): Promise<ResolvedWorkspaceTarget>
```

Resolution requirements:

1. Require an absolute `cwd`, then `resolve(cwd)`.
2. Normalize `selectedFolder` and `path`; `path` must equal or descend from `selectedFolder`.
3. Resolve both paths lexically and reject escape before any disk access.
4. For existing targets, compare `realpath(target)` against `realpath(cwd)` and reject symlinks whose result escapes.
5. Reject editing a symlink itself with `WORKSPACE_SYMLINK_FORBIDDEN`.
6. For a new target, validate the real parent and selected root before returning.

`listWorkspaceDirectory()` calls `readdir({ withFileTypes: true })`, uses `lstat` for timestamps/bytes, keeps true parent paths, and sorts directories before files with `localeCompare`. `listWorkspaceFolders()` returns directories and non-escaping symlinks are shown as `symlink` but not selectable. `readWorkspaceSummary()` returns the real root/selection with watcher initially `unavailable` and sequence `0`.

- [ ] **Step 4: Build and pass the Explorer tests**

Run:

```powershell
npm run build
node --import tsx --test tests/workspace-explorer.test.ts
```

Expected: both tests PASS on Windows.

- [ ] **Step 5: Commit lazy real-tree support**

```powershell
git add plugins/dsh-frontend-feedback/src/workspace-explorer.ts plugins/dsh-frontend-feedback/src/index.ts plugins/dsh-frontend-feedback/tests/workspace-explorer.test.ts
git commit -m "feat: browse the real PageCraft workspace tree"
```

---

### Task 3: Add real file reads, atomic writes, entry mutations, image metadata, and history

**Files:**
- Modify: `plugins/dsh-frontend-feedback/src/workspace-explorer.ts`
- Modify: `plugins/dsh-frontend-feedback/tests/workspace-explorer.test.ts`
- Modify: `plugins/dsh-frontend-feedback/src/index.ts` (exports only)

**Interfaces:**
- Consumes: `resolveWorkspaceTarget()` and workspace types from Tasks 1–2.
- Produces: `readWorkspaceFile()`, `readWorkspaceBlob()`, `saveWorkspaceFile()`, `createWorkspaceEntry()`, `renameWorkspaceEntry()`, `deleteWorkspaceEntry()`, `readWorkspaceHistory()`, and `restoreWorkspaceHistory()`.

- [ ] **Step 1: Add failing file-operation and conflict tests**

```ts
test('workspace writes real files atomically and refuses stale hashes', async (t) => {
  const cwd = await createWorkspaceFixture(t)
  const opened = await readWorkspaceFile(cwd, 'slides', 'slides/deck.json')
  const saved = await saveWorkspaceFile(cwd, 'slides', opened.path, '{"title":"new"}\n', opened.hash)
  assert.equal(await readFile(join(cwd, 'slides', 'deck.json'), 'utf8'), '{"title":"new"}\n')
  await writeFile(join(cwd, 'slides', 'deck.json'), '{"title":"external"}\n')
  await assert.rejects(
    () => saveWorkspaceFile(cwd, 'slides', opened.path, opened.content, saved.hash),
    (error: any) => error.code === 'WORKSPACE_FILE_CONFLICT',
  )
})

test('workspace mutations stay inside the selected root and history restores by hash', async (t) => {
  const cwd = await createWorkspaceFixture(t)
  await createWorkspaceEntry(cwd, 'slides', { parent: 'slides', name: 'notes.md', kind: 'file', content: '# Notes\n' })
  await renameWorkspaceEntry(cwd, 'slides', 'slides/notes.md', 'speaker.md')
  const file = await readWorkspaceFile(cwd, 'slides', 'slides/speaker.md')
  const changed = await saveWorkspaceFile(cwd, 'slides', file.path, '# Changed\n', file.hash)
  const [revision] = await readWorkspaceHistory(cwd, 'slides', file.path)
  assert.ok(revision)
  const restored = await restoreWorkspaceHistory(cwd, 'slides', file.path, revision.id, changed.hash)
  assert.equal(restored.content, '# Notes\n')
  await deleteWorkspaceEntry(cwd, 'slides', file.path)
  await assert.rejects(() => readWorkspaceFile(cwd, 'slides', file.path), /不存在/)
  await assert.rejects(() => deleteWorkspaceEntry(cwd, 'slides', 'slides'), /根目录/)
})
```

Add this fixture helper and import `TestContext` from `node:test`:

```ts
async function createWorkspaceFixture(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'pagecraft-file-ops-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await mkdir(join(cwd, 'slides', 'assets'), { recursive: true })
  await writeFile(join(cwd, 'slides', 'deck.json'), '{"title":"old"}\n')
  await writeFile(join(cwd, 'slides', 'assets', 'machine.png'), Buffer.from([137, 80, 78, 71]))
  return cwd
}
```

- [ ] **Step 2: Run the focused tests and verify missing operations fail**

Run:

```powershell
npm run build
node --import tsx --test tests/workspace-explorer.test.ts
```

Expected: the new tests FAIL on missing exports.

- [ ] **Step 3: Implement file operations with exact safety rules**

Use these operation signatures:

```ts
export interface WorkspaceOptions {
  maxTextBytes?: number
  historyLimit?: number
  historyMaxBytes?: number
}

export interface WorkspaceEntryInput {
  parent: string
  name: string
  kind: 'file' | 'directory'
  content?: string
}

export async function readWorkspaceFile(cwd: string, selectedFolder: string, path: unknown, options?: WorkspaceOptions): Promise<WorkspaceFile>
export async function readWorkspaceBlob(cwd: string, selectedFolder: string, path: unknown, options?: WorkspaceOptions): Promise<{ body: Buffer; mimeType: string }>
export async function saveWorkspaceFile(cwd: string, selectedFolder: string, path: unknown, content: string, baseHash: string, options?: WorkspaceOptions): Promise<WorkspaceFile>
export async function createWorkspaceEntry(cwd: string, selectedFolder: string, input: WorkspaceEntryInput): Promise<WorkspaceEntry>
export async function renameWorkspaceEntry(cwd: string, selectedFolder: string, path: unknown, nextName: unknown): Promise<WorkspaceEntry>
export async function deleteWorkspaceEntry(cwd: string, selectedFolder: string, path: unknown): Promise<void>
export async function readWorkspaceHistory(cwd: string, selectedFolder: string, path: unknown, options?: WorkspaceOptions): Promise<WorkspaceHistoryEntry[]>
export async function restoreWorkspaceHistory(cwd: string, selectedFolder: string, path: unknown, historyId: unknown, baseHash: string, options?: WorkspaceOptions): Promise<WorkspaceFile>
```

Implementation rules:

- use SHA-256 for content hashes;
- reject unsupported text and files over 2 MiB before UTF-8 decode;
- allow blob reads only for recognized PNG/JPEG/WebP/GIF images and return `nosniff`-safe MIME types; treat SVG as editable source text rather than active image content;
- write a same-directory `.<name>.<uuid>.pagecraft-tmp` and rename it over the target;
- save history before write/restore/delete under `.pagecraft/workspace-history/<sha256-relative-path>/`;
- cap history at 20 entries and 20 MiB total, deleting oldest entries first;
- accept only a single filename for rename, not a path;
- reject deleting the session root or selected root;
- recursively delete only the exact validated selected target after caller confirmation in UI.

- [ ] **Step 4: Run Explorer tests and the existing presentation regressions**

Run:

```powershell
npm run build
node --import tsx --test tests/workspace-explorer.test.ts tests/plugin.test.ts
```

Expected: all tests PASS; existing presentation project asset tests remain unchanged.

- [ ] **Step 5: Commit file operations**

```powershell
git add plugins/dsh-frontend-feedback/src/workspace-explorer.ts plugins/dsh-frontend-feedback/src/index.ts plugins/dsh-frontend-feedback/tests/workspace-explorer.test.ts
git commit -m "feat: edit real PageCraft workspace files safely"
```

---

### Task 4: Add a coalesced recursive watcher and reconciliation signals

**Files:**
- Create: `plugins/dsh-frontend-feedback/src/workspace-watcher.ts`
- Create: `plugins/dsh-frontend-feedback/tests/workspace-watcher.test.ts`
- Modify: `plugins/dsh-frontend-feedback/src/index.ts` (exports only)

**Interfaces:**
- Consumes: validated absolute selected roots from `resolveWorkspaceTarget()`.
- Produces: `WorkspaceWatchHub` and monotonic `WorkspaceEvent` invalidations.

- [ ] **Step 1: Write failing coalescing and external-change tests**

```ts
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WorkspaceWatchHub } from '../lib/index.js'

function waitForEvent(events: Array<{ paths: string[] }>, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`missing watcher event for ${path}`)), 3000)
    const poll = setInterval(() => {
      if (!events.some(event => event.paths.includes(path))) return
      clearTimeout(deadline)
      clearInterval(poll)
      resolve()
    }, 25)
  })
}

test('watch hub batches disk changes and shares one root watcher', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pagecraft-watch-'))
  await mkdir(join(root, 'assets'))
  const hub = new WorkspaceWatchHub({ debounceMs: 150 })
  t.after(async () => { hub.dispose(); await rm(root, { recursive: true, force: true }) })
  const first: any[] = []
  const second: any[] = []
  const unsubscribeA = hub.subscribe(root, event => first.push(event))
  const unsubscribeB = hub.subscribe(root, event => second.push(event))
  t.after(unsubscribeA)
  t.after(unsubscribeB)

  await writeFile(join(root, 'assets', 'one.png'), Buffer.from([1]))
  await writeFile(join(root, 'assets', 'two.png'), Buffer.from([2]))
  await waitForEvent(first, 'assets')
  assert.equal(second.at(-1)?.sequence, first.at(-1)?.sequence)
  assert.equal(hub.activeRootCount(), 1)
})
```

- [ ] **Step 2: Run and verify the watcher class is missing**

Run:

```powershell
npm run build
node --import tsx --test tests/workspace-watcher.test.ts
```

Expected: FAIL because `WorkspaceWatchHub` is not exported.

- [ ] **Step 3: Implement one watcher per root with batched invalidation**

Use this public interface:

```ts
export interface WorkspaceWatchOptions {
  debounceMs?: number
  heartbeatMs?: number
}

export class WorkspaceWatchHub {
  constructor(options: WorkspaceWatchOptions = {})
  subscribe(root: string, listener: (event: WorkspaceEvent) => void): () => void
  markOwnWrite(root: string, path: string): void
  currentSequence(root: string): number
  status(root: string): 'connected' | 'degraded' | 'unavailable'
  activeRootCount(): number
  dispose(): void
}
```

For each root, call `watch(root, { recursive: true })`. Convert any raw event into invalidation of the changed entry's parent directory; when filename is absent or malformed, emit `{ kind: 'rescan', paths: ['.'] }`. Collect parent paths in a `Set`, flush after 150 ms, increment one sequence, and send the same event to all subscribers. Ignore `.pagecraft/workspace-history` and PageCraft temporary filenames. `markOwnWrite()` suppresses only matching raw events for 500 ms; it must still allow the caller to update its own UI from the write response.

If the watcher emits `error`, send a root rescan event and set the root status to degraded. Close the native watcher when its final subscriber leaves and clear every timer in `dispose()`.

- [ ] **Step 4: Pass watcher tests three consecutive times**

Run:

```powershell
npm run build
1..3 | ForEach-Object { node --import tsx --test tests/workspace-watcher.test.ts; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
```

Expected: all three runs PASS without leaked handles.

- [ ] **Step 5: Commit watcher support**

```powershell
git add plugins/dsh-frontend-feedback/src/workspace-watcher.ts plugins/dsh-frontend-feedback/src/index.ts plugins/dsh-frontend-feedback/tests/workspace-watcher.test.ts
git commit -m "feat: watch PageCraft workspace changes"
```

---

### Task 5: Register session-scoped workspace and SSE routes

**Files:**
- Modify: `plugins/dsh-frontend-feedback/src/index.ts`
- Modify: `plugins/dsh-frontend-feedback/tests/plugin.test.ts`

**Interfaces:**
- Consumes: Explorer operations from Tasks 2–3 and `WorkspaceWatchHub` from Task 4.
- Produces: HTTP APIs declared in `workspace.ts`, including an SSE stream whose cleanup follows request close and plugin disposal.

- [ ] **Step 1: Update route-registration tests to fail on missing generic routes**

Add the generic routes after preview resource routes and before presentation routes in the expected registration array:

```ts
const workspaceRoutes = [
  '/api/frontend-feedback/workspace',
  '/api/frontend-feedback/workspace/folders',
  '/api/frontend-feedback/workspace/directory',
  '/api/frontend-feedback/workspace/file',
  '/api/frontend-feedback/workspace/blob',
  '/api/frontend-feedback/workspace/entry',
  '/api/frontend-feedback/workspace/history',
  '/api/frontend-feedback/workspace/restore',
  '/api/frontend-feedback/workspace/events',
]
for (const path of workspaceRoutes) assert.ok(registrations.some((route: any) => route.path === path), path)
```

Add a route invocation test using a session fixture with `cwd`, calling the directory handler with `sessionId=session-1&selectedFolder=.&path=.` and asserting a `200` JSON response.

- [ ] **Step 2: Build and verify route assertions fail**

Run:

```powershell
npm run build
node --import tsx --test tests/plugin.test.ts
```

Expected: FAIL because generic workspace routes are absent.

- [ ] **Step 3: Register handlers and lifecycle cleanup**

Create one `WorkspaceWatchHub` inside `apply()` and register its disposal through `ctx.effect`:

```ts
const workspaceWatchHub = new WorkspaceWatchHub()
ctx.effect(() => () => workspaceWatchHub.dispose(), 'frontend-feedback: workspace watcher')
```

Use the existing `presentationRequest()` session lookup temporarily, then rename it to `sessionWorkspaceRequest()` and change its error copy from presentation-specific wording to workspace wording. Each handler reads `selectedFolder` and `path` from the URL or JSON body and delegates all validation to `workspace-explorer.ts`. The summary handler combines `readWorkspaceSummary()` with `workspaceWatchHub.status(selectedPath)` and `workspaceWatchHub.currentSequence(selectedPath)`.

SSE response headers and cleanup are exact:

```ts
res.writeHead(200, {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-content-type-options': 'nosniff',
})
res.write(`event: ready\ndata: ${JSON.stringify({ sequence: hub.currentSequence(selectedPath) })}\n\n`)
const unsubscribe = hub.subscribe(selectedPath, event => {
  if (!res.writableEnded) res.write(`event: workspace\ndata: ${JSON.stringify(event)}\n\n`)
})
const heartbeat = setInterval(() => {
  if (!res.writableEnded) res.write(': heartbeat\n\n')
}, 20_000)
res.once('close', () => { clearInterval(heartbeat); unsubscribe() })
```

For blob responses set `cache-control: no-store`, `x-content-type-options: nosniff`, and the exact MIME returned by the Explorer. Map `WorkspaceExplorerError` through the existing JSON error envelope.

- [ ] **Step 4: Run host route and workspace suites**

Run:

```powershell
npm run build
node --import tsx --test tests/workspace-contracts.test.ts tests/workspace-explorer.test.ts tests/workspace-watcher.test.ts tests/plugin.test.ts
```

Expected: all tests PASS and the process exits normally.

- [ ] **Step 5: Commit host workspace APIs**

```powershell
git add plugins/dsh-frontend-feedback/src/index.ts plugins/dsh-frontend-feedback/tests/plugin.test.ts
git commit -m "feat: expose session-scoped workspace APIs"
```

---

### Task 6: Build the real three-column Explorer client

**Files:**
- Create: `plugins/dsh-frontend-feedback/src/client/workspace-state.ts`
- Create: `plugins/dsh-frontend-feedback/tests/workspace-state.test.ts`
- Create: `plugins/dsh-frontend-feedback/src/client/workspace.tsx`
- Modify: `plugins/dsh-frontend-feedback/src/client/index.tsx`
- Delete after replacement: `plugins/dsh-frontend-feedback/src/client/source-workspace.tsx`

**Interfaces:**
- Consumes: workspace HTTP contracts from Task 1 and routes from Task 5.
- Produces: `PageCraftWorkspace` and pure `WorkspaceTreeState` reducers for lazy directory caching.

- [ ] **Step 1: Write failing tree-state tests**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { applyDirectoryListing, invalidateWorkspacePaths, initialWorkspaceTreeState } from '../src/client/workspace-state.ts'

test('lazy workspace state preserves exact parents and expansion', () => {
  let state = initialWorkspaceTreeState('slides')
  state = applyDirectoryListing(state, 'slides', [
    { path: 'slides/assets', name: 'assets', kind: 'directory', updatedAt: '1', textEditable: false, imagePreviewable: false },
    { path: 'slides/deck.json', name: 'deck.json', kind: 'file', bytes: 2, updatedAt: '1', textEditable: true, imagePreviewable: false },
  ])
  state = { ...state, expanded: new Set(['slides', 'slides/assets']) }
  state = applyDirectoryListing(state, 'slides/assets', [
    { path: 'slides/assets/machine.png', name: 'machine.png', kind: 'file', bytes: 4, updatedAt: '1', textEditable: false, imagePreviewable: true },
  ])
  assert.deepEqual(state.children.get('slides/assets')?.map(item => item.path), ['slides/assets/machine.png'])
  assert.equal(state.expanded.has('slides/assets'), true)
  state = invalidateWorkspacePaths(state, ['slides/assets'])
  assert.equal(state.stale.has('slides/assets'), true)
})
```

- [ ] **Step 2: Run the state test and verify it fails**

Run:

```powershell
node --import tsx --test tests/workspace-state.test.ts
```

Expected: FAIL because `workspace-state.ts` does not exist.

- [ ] **Step 3: Implement state helpers and the new workspace component**

Define the pure state interface:

```ts
export interface WorkspaceTreeState {
  selectedFolder: string
  children: Map<string, WorkspaceEntry[]>
  expanded: Set<string>
  loading: Set<string>
  stale: Set<string>
}
```

`PageCraftWorkspace` has these explicit props:

```ts
interface PageCraftWorkspaceProps {
  sessionId: string
  previewSrc: string
  onClose(): void
  onRefreshPreview(): void
  onSelection(selection: FeedbackSelection): void
  onPreviewWindowChange(value: Window | null): void
  onStatus(message: string): void
}
```

The component first requests the summary for `selectedFolder=.` to learn `rootPath`, then reads `workspaceFolderStorageKey(summary.rootPath, sessionId)` and validates the remembered folder through a second summary request.

Implement:

- a DSH-rooted folder picker using `workspace/folders`, not an unrestricted browser file picker;
- remembered selected folder through `workspaceFolderStorageKey(workspaceRoot, sessionId)`;
- lazy directory requests when expanding a folder;
- exact disk paths and folder-first sorting from server response;
- breadcrumb relative to DSH root;
- create/rename/delete actions with exact target confirmation;
- CodeMirror for editable text, existing hash-based conflict UI, and history restore;
- image preview through `workspace/blob` with metadata from the entry;
- binary metadata view for unsupported files;
- three resizable columns: tree, editor/image, preview;
- collapse/maximize controls and persisted layout;
- Back, Forward, Refresh, Select Text, Select Element, and Select Area controls above the workspace preview.

Keep direct text button disabled in this task; it becomes functional in Task 11. Remove `source-workspace.tsx` only after the new component provides all current save/history/layout behavior.

- [ ] **Step 4: Run state, build, and bundle smoke tests**

Run:

```powershell
node --import tsx --test tests/workspace-state.test.ts
npm run build
node --import tsx --test tests/plugin.test.ts
```

Expected: state test PASS; bundle builds; plugin smoke test contains `PageCraftWorkspace`, `打开文件夹`, and `/workspace/directory`.

- [ ] **Step 5: Commit the real Explorer UI**

```powershell
git add plugins/dsh-frontend-feedback/src/client/workspace-state.ts plugins/dsh-frontend-feedback/src/client/workspace.tsx plugins/dsh-frontend-feedback/src/client/index.tsx plugins/dsh-frontend-feedback/tests/workspace-state.test.ts plugins/dsh-frontend-feedback/tests/plugin.test.ts
git commit -m "feat: add the real PageCraft file Explorer"
```

---

### Task 7: Synchronize external changes without overwriting dirty drafts

**Files:**
- Modify: `plugins/dsh-frontend-feedback/src/client/workspace-state.ts`
- Modify: `plugins/dsh-frontend-feedback/src/client/workspace.tsx`
- Modify: `plugins/dsh-frontend-feedback/tests/workspace-state.test.ts`

**Interfaces:**
- Consumes: `WorkspaceEvent` SSE payloads and the lazy tree state from Task 6.
- Produces: `applyWorkspaceEvent()` and clean-versus-dirty open-file reconciliation.

- [ ] **Step 1: Add failing watcher-reduction and dirty-buffer tests**

```ts
test('external changes reload clean files but preserve dirty drafts', () => {
  const clean = {
    path: 'slides/deck.json',
    file: { content: '{"a":1}\n', hash: 'old', updatedAt: '1' },
    draft: '{"a":1}\n',
    conflict: null,
  }
  const dirty = { ...clean, draft: '{"a":2}\n' }
  const disk = { content: '{"a":3}\n', hash: 'new', updatedAt: '2' }
  assert.deepEqual(reconcileOpenFile(clean, disk), { ...clean, file: disk, draft: disk.content, conflict: null })
  assert.deepEqual(reconcileOpenFile(dirty, disk), { ...dirty, conflict: disk })
})

test('missed SSE sequence requests a root rescan', () => {
  const result = applyWorkspaceEvent(initialWorkspaceTreeState('slides'), 4, {
    sequence: 7,
    kind: 'invalidate',
    paths: ['slides/assets'],
  })
  assert.equal(result.lastSequence, 7)
  assert.equal(result.rescanRequired, true)
  assert.equal(result.tree.stale.has('slides'), true)
})
```

- [ ] **Step 2: Run and verify reducer exports fail**

Run:

```powershell
node --import tsx --test tests/workspace-state.test.ts
```

Expected: FAIL on missing `reconcileOpenFile()` and `applyWorkspaceEvent()`.

- [ ] **Step 3: Connect SSE, focus reconciliation, and conflict UI**

Implement these pure reducer boundaries:

```ts
export interface OpenWorkspaceFileState {
  path: string
  file: Pick<WorkspaceFile, 'content' | 'hash' | 'updatedAt'>
  draft: string
  conflict: Pick<WorkspaceFile, 'content' | 'hash' | 'updatedAt'> | null
}

export interface WorkspaceEventReduction {
  tree: WorkspaceTreeState
  lastSequence: number
  rescanRequired: boolean
}

export function reconcileOpenFile(
  state: OpenWorkspaceFileState,
  disk: Pick<WorkspaceFile, 'content' | 'hash' | 'updatedAt'>,
): OpenWorkspaceFileState

export function applyWorkspaceEvent(
  tree: WorkspaceTreeState,
  lastSequence: number,
  event: WorkspaceEvent,
): WorkspaceEventReduction
```

In the React component:

1. Open one `EventSource` for the selected folder.
2. On `workspace`, mark paths stale and immediately refetch expanded stale directories.
3. Refetch affected open files; clean files reload automatically, dirty files receive a conflict banner.
4. On sequence gaps or `rescan`, reload the root plus every currently expanded directory.
5. On `window.focus`, fetch workspace summary and re-read expanded directory metadata; do not replace dirty drafts.
6. On SSE error, show `同步已中断，可点击刷新重新检查文件` and keep the manual Refresh action available.
7. Close the EventSource when folder/session/component changes.

After a PageCraft-originated save, update the open file and affected parent from the HTTP result; do not wait for the watcher echo.

- [ ] **Step 4: Run state and full client build tests**

Run:

```powershell
node --import tsx --test tests/workspace-state.test.ts
npm run build
node --import tsx --test tests/plugin.test.ts
```

Expected: all tests PASS and the browser bundle contains `EventSource` and the conflict copy.

- [ ] **Step 5: Commit external synchronization**

```powershell
git add plugins/dsh-frontend-feedback/src/client/workspace-state.ts plugins/dsh-frontend-feedback/src/client/workspace.tsx plugins/dsh-frontend-feedback/tests/workspace-state.test.ts plugins/dsh-frontend-feedback/tests/plugin.test.ts
git commit -m "feat: synchronize PageCraft Explorer with disk"
```

---

### Task 8: Add a dedicated DOM text-selection and verification protocol

**Files:**
- Modify: `plugins/dsh-frontend-feedback/src/shared.ts`
- Modify: `plugins/dsh-frontend-feedback/src/annotator-script.ts`
- Modify: `plugins/dsh-frontend-feedback/src/client/index.tsx`
- Modify: `plugins/dsh-frontend-feedback/src/client/workspace.tsx`
- Modify: `plugins/dsh-frontend-feedback/tests/plugin.test.ts`

**Interfaces:**
- Consumes: the existing annotator `postMessage` channel and shared `FeedbackSelection` flow.
- Produces: selection mode `'text'`, `DomTextSelection` evidence messages, and transaction verification responses.

- [ ] **Step 1: Add failing shared-guard and bundle tests**

```ts
test('DOM text evidence validates bounded source-resolution context', () => {
  assert.equal(isDomTextSelection({
    pageUrl: 'http://localhost:5173/slides/1',
    framePath: [],
    selector: '[data-pagecraft-text-key="slide-01.title"]',
    fingerprint: 'slide-01.title|h1|0',
    displayedText: '旧标题',
    tagName: 'h1',
    attributes: { 'data-pagecraft-text-key': 'slide-01.title' },
    nearbyText: ['副标题'],
    slideId: 'slide-01',
    textKey: 'slide-01.title',
  }), true)
  assert.equal(isDomTextSelection({ displayedText: 'x' }), false)
})
```

Add bundle assertions for `dsh-pagecraft-text-selected`, `dsh-pagecraft-verify-text`, and `dsh-pagecraft-text-verification`.

- [ ] **Step 2: Build and verify tests fail**

Run:

```powershell
npm run build
node --import tsx --test tests/plugin.test.ts
```

Expected: FAIL because the guard and message names are absent.

- [ ] **Step 3: Implement bounded evidence collection and verification**

Extend selection mode to:

```ts
export type SelectionMode = 'element' | 'area' | 'text'
```

In the annotator:

- choose the nearest element containing meaningful direct or descendant text, excluding annotator UI, `script`, `style`, `input`, `textarea`, canvas, SVG-only labels, and empty text;
- normalize displayed text with collapsed whitespace and cap it at 2,000 characters;
- collect at most eight safe attributes: `id`, first four classes, `name`, `role`, `data-testid`, `data-pagecraft-slide-id`, and `data-pagecraft-text-key`;
- collect at most four nearby text strings of 120 characters each;
- compute `fingerprint` from text key when present, otherwise slide ID + selector + tag + sibling index;
- post `{ type: 'dsh-pagecraft-text-selected', payload }` in text mode;
- on `{ type: 'dsh-pagecraft-verify-text', transactionId, selection }`, find by text key first and selector second, compare the fingerprint context, and post `{ type: 'dsh-pagecraft-text-verification', transactionId, found, observedText }`.

Do not change the existing `dsh-frontend-feedback-selected` payload or comment prompt serialization.

- [ ] **Step 4: Build and pass shared/bundle regressions**

Run:

```powershell
npm run build
node --import tsx --test tests/plugin.test.ts
```

Expected: all plugin tests PASS; existing element and area guard tests remain green.

- [ ] **Step 5: Commit the text-selection protocol**

```powershell
git add plugins/dsh-frontend-feedback/src/shared.ts plugins/dsh-frontend-feedback/src/annotator-script.ts plugins/dsh-frontend-feedback/src/client/index.tsx plugins/dsh-frontend-feedback/src/client/workspace.tsx plugins/dsh-frontend-feedback/tests/plugin.test.ts
git commit -m "feat: collect DOM text source evidence"
```

---

### Task 9: Build bounded source parsers and a unique-target resolver

**Files:**
- Create: `plugins/dsh-frontend-feedback/src/source-text-parsers.ts`
- Create: `plugins/dsh-frontend-feedback/src/source-text-resolver.ts`
- Create: `plugins/dsh-frontend-feedback/tests/source-text-resolver.test.ts`
- Modify: `plugins/dsh-frontend-feedback/package.json`
- Modify: `plugins/dsh-frontend-feedback/package-lock.json`
- Modify: `plugins/dsh-frontend-feedback/src/index.ts` (exports only)

**Interfaces:**
- Consumes: `DomTextSelection`, selected folder bounds, and Explorer file reads.
- Produces: `SourceTextCandidate`, `ResolvedSourceText`, `parseSourceTextCandidates()`, and `resolveDomTextSource()`.

- [ ] **Step 1: Install exact parser dependencies**

Run:

```powershell
cd plugins/dsh-frontend-feedback
npm install @babel/parser@^7.28.0 parse5@^8.0.0 jsonc-parser@^3.3.1
```

Expected: `package.json` and `package-lock.json` contain all three runtime dependencies.

- [ ] **Step 2: Write resolver tests before implementation**

```ts
test('resolver handles PageCraft keys, JSX props, Vue, Svelte, HTML, Markdown, JSON and i18n', async (t) => {
  const cwd = await resolverFixture(t, {
    'src/deck.json': '{"slides":[{"id":"slide-01","title":"旧标题"}]}\n',
    'src/App.tsx': 'const title = "产品介绍"; export function App(){ return <h1>{title}</h1> }\n',
    'src/Card.vue': '<template><h2>功能概览</h2></template>\n',
    'src/End.svelte': '<h2>谢谢观看</h2>\n',
    'src/index.html': '<p class="lead">欢迎使用</p>\n',
    'src/notes.md': '# 项目背景\n',
    'src/zh-CN.json': '{"hero.title":"智能制造"}\n',
  })
  const keyed = await resolveDomTextSource(cwd, 'src', selection('旧标题', { textKey: 'slide-01.title', slideId: 'slide-01' }))
  assert.deepEqual([keyed.path, keyed.kind], ['src/deck.json', 'json-value'])
  const jsx = await resolveDomTextSource(cwd, 'src', selection('产品介绍', { tagName: 'h1' }))
  assert.deepEqual([jsx.path, jsx.kind], ['src/App.tsx', 'string-literal'])
  for (const [text, path] of [['功能概览', 'src/Card.vue'], ['谢谢观看', 'src/End.svelte'], ['欢迎使用', 'src/index.html'], ['项目背景', 'src/notes.md']]) {
    assert.equal((await resolveDomTextSource(cwd, 'src', selection(text))).path, path)
  }
})

test('resolver refuses ambiguous, dynamic and outside-folder text', async (t) => {
  const cwd = await resolverFixture(t, {
    'src/A.tsx': 'export const A=()=> <p>重复文字</p>\n',
    'src/B.tsx': 'export const B=()=> <p>重复文字</p>\n',
    'src/Api.tsx': 'export const Api=({value})=> <p>{value}</p>\n',
    'outside.tsx': 'export const Outside=()=> <p>外部文字</p>\n',
  })
  await assert.rejects(() => resolveDomTextSource(cwd, 'src', selection('重复文字')), (error: any) => error.code === 'TEXT_SOURCE_AMBIGUOUS')
  await assert.rejects(
    () => resolveDomTextSource(cwd, 'src', selection('接口文字', { pageUrl: 'http://localhost:5173/Api', tagName: 'p' })),
    (error: any) => error.code === 'TEXT_SOURCE_DYNAMIC',
  )
  await assert.rejects(
    () => resolveDomTextSource(cwd, 'src', selection('外部文字')),
    (error: any) => error.code === 'TEXT_SOURCE_OUTSIDE_FOLDER',
  )
})
```

Define the fixtures in the same test file:

```ts
async function resolverFixture(t: TestContext, files: Record<string, string>): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'pagecraft-resolver-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(cwd, ...path.split('/'))
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content)
  }
  return cwd
}

function selection(displayedText: string, overrides: Partial<DomTextSelection> = {}): DomTextSelection {
  return {
    pageUrl: 'http://localhost:5173/',
    framePath: [],
    selector: 'p',
    fingerprint: `p|${displayedText}`,
    displayedText,
    tagName: 'p',
    attributes: {},
    nearbyText: [],
    ...overrides,
  }
}
```

- [ ] **Step 3: Run resolver tests and verify they fail**

Run:

```powershell
npm run build
node --import tsx --test tests/source-text-resolver.test.ts
```

Expected: FAIL because parser and resolver exports do not exist.

- [ ] **Step 4: Implement parsers with exact source ranges**

Define:

```ts
export type SourceTextKind = 'markup-text' | 'string-literal' | 'json-value' | 'markdown-text'

export interface SourceTextCandidate {
  path: string
  kind: SourceTextKind
  value: string
  start: number
  end: number
  line: number
  tagName?: string
  attributeNames: string[]
  propertyPath?: string[]
  importSource?: string
  symbolName?: string
}

export interface ResolvedSourceText extends SourceTextCandidate {
  confidence: 'high'
  replacement: string
}
```

Parser behavior:

- `parse5` with source locations for `.html` and the template portions of `.vue`/`.svelte`;
- `@babel/parser` with `typescript`, `jsx`, `decorators-legacy`, and `importAttributes` plugins for JS/TS/JSX/TSX and script portions;
- `jsonc-parser` visitor offsets and property paths for JSON/JSONC;
- line-based Markdown/MDX text nodes excluding fenced code, inline code, URLs, and front matter;
- preserve decoded display value while storing exact raw source ranges;
- replace only the value range and escape for the owning syntax/quote style.

Implement `resolveDomTextSource()` with these hard limits: 2,000 files, 20 MiB total text, 1.5 seconds wall time, eight local import hops. Ignore `.git`, `node_modules`, `dist`, `build`, `.next`, `.nuxt`, `coverage`, `.pagecraft/workspace-history`, minified files, and files over 2 MiB. If no in-folder candidate exists, perform one exact-text-only scan in the rest of the session `cwd`, subject to the same remaining limits; a unique outside match returns `TEXT_SOURCE_OUTSIDE_FOLDER` so the UI can ask the user to open the parent folder.

Ranking requires at least two independent signals unless `textKey` resolves a PageCraft deck path. Signals are: exact normalized text, text key/property path, slide ID, matching tag, matching safe attribute, nearby text, URL-to-file stem, and a statically resolved local import/prop chain. Return only one candidate whose score is at least 80 and at least 20 points above second place. Throw exact codes `TEXT_SOURCE_NOT_FOUND`, `TEXT_SOURCE_AMBIGUOUS`, `TEXT_SOURCE_DYNAMIC`, `TEXT_SOURCE_LIMIT`, or `TEXT_SOURCE_OUTSIDE_FOLDER` otherwise.

For common programmatic chains, follow local constants, object/array properties, imports, component props, and translation-key lookups only when every hop is statically resolvable. Do not execute source code or evaluate arbitrary expressions.

- [ ] **Step 5: Run resolver and full host tests**

Run:

```powershell
npm run build
node --import tsx --test tests/source-text-resolver.test.ts tests/workspace-explorer.test.ts tests/plugin.test.ts
```

Expected: all tests PASS, including ambiguous/dynamic safe failures.

- [ ] **Step 6: Commit source resolution**

```powershell
git add plugins/dsh-frontend-feedback/src/source-text-parsers.ts plugins/dsh-frontend-feedback/src/source-text-resolver.ts plugins/dsh-frontend-feedback/src/index.ts plugins/dsh-frontend-feedback/tests/source-text-resolver.test.ts plugins/dsh-frontend-feedback/package.json plugins/dsh-frontend-feedback/package-lock.json
git commit -m "feat: resolve visible text to local source"
```

---

### Task 10: Add hash-safe two-phase direct text transactions

**Files:**
- Create: `plugins/dsh-frontend-feedback/src/direct-text-edit.ts`
- Create: `plugins/dsh-frontend-feedback/tests/direct-text-edit.test.ts`
- Modify: `plugins/dsh-frontend-feedback/src/index.ts`

**Interfaces:**
- Consumes: `resolveDomTextSource()`, Explorer atomic/history operations, `DomTextSelection`, and workspace request routing.
- Produces: `DirectTextEditService.start()` and `.verify()` plus `/workspace/text-edit` and `/workspace/text-verify`.

- [ ] **Step 1: Write failing commit, rollback, and conflict tests**

```ts
test('direct text transaction commits only after verified DOM text', async (t) => {
  const cwd = await directEditFixture(t, 'export const App=()=> <h1>旧标题</h1>\n')
  const service = new DirectTextEditService({ verificationTimeoutMs: 8_000, retentionMs: 120_000 })
  t.after(() => service.dispose())
  const started = await service.start(cwd, 'src', selection('旧标题'), '新标题')
  assert.match(await readFile(join(cwd, 'src', 'App.tsx'), 'utf8'), /新标题/)
  const result = await service.verify(cwd, { transactionId: started.transactionId, verified: true, observedText: '新标题' })
  assert.equal(result.status, 'committed')
})

test('failed verification rolls back only when written hash is still current', async (t) => {
  const cwd = await directEditFixture(t, 'export const App=()=> <h1>旧标题</h1>\n')
  const service = new DirectTextEditService()
  t.after(() => service.dispose())
  const started = await service.start(cwd, 'src', selection('旧标题'), '错误标题')
  const rolledBack = await service.verify(cwd, { transactionId: started.transactionId, verified: false, observedText: '旧标题' })
  assert.equal(rolledBack.status, 'rolled_back')
  assert.match(await readFile(join(cwd, 'src', 'App.tsx'), 'utf8'), /旧标题/)

  const second = await service.start(cwd, 'src', selection('旧标题'), '第二标题')
  await writeFile(join(cwd, 'src', 'App.tsx'), 'export const App=()=> <h1>外部修改</h1>\n')
  const conflict = await service.verify(cwd, { transactionId: second.transactionId, verified: false, observedText: '外部修改' })
  assert.equal(conflict.status, 'conflict')
  assert.match(await readFile(join(cwd, 'src', 'App.tsx'), 'utf8'), /外部修改/)
})
```

Define the direct-edit fixture locally rather than importing test helpers from another suite:

```ts
async function directEditFixture(t: TestContext, source: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'pagecraft-direct-edit-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await mkdir(join(cwd, 'src'), { recursive: true })
  await writeFile(join(cwd, 'src', 'App.tsx'), source)
  return cwd
}

function selection(displayedText: string): DomTextSelection {
  return {
    pageUrl: 'http://localhost:5173/',
    framePath: [],
    selector: 'h1',
    fingerprint: `h1|${displayedText}`,
    displayedText,
    tagName: 'h1',
    attributes: {},
    nearbyText: [],
  }
}
```

- [ ] **Step 2: Run and verify the service is missing**

Run:

```powershell
npm run build
node --import tsx --test tests/direct-text-edit.test.ts
```

Expected: FAIL because `DirectTextEditService` is not exported.

- [ ] **Step 3: Implement the reversible service and routes**

Use this service boundary:

```ts
export interface DirectTextEditOptions {
  verificationTimeoutMs?: number
  retentionMs?: number
}

export class DirectTextEditService {
  constructor(options: DirectTextEditOptions = {})
  start(cwd: string, selectedFolder: string, selection: DomTextSelection, replacementText: string): Promise<DirectTextEditStart>
  verify(cwd: string, verification: DirectTextEditVerification): Promise<DirectTextEditResult>
  dispose(): void
}
```

`start()` must:

1. validate replacement as non-empty-or-empty intentional text capped at 10,000 characters;
2. resolve one source range;
3. re-read and hash the file;
4. save the original history revision;
5. apply exactly one range edit and atomic write;
6. retain original content, original hash, written hash, path, line, expected text, cwd, and expiry under a random transaction ID.

`verify()` commits only when `verified === true` and normalized `observedText` equals the expected replacement. Otherwise it re-reads the file and rolls back only if its hash still equals `writtenHash`. If another tool changed it, return `conflict` without writing. Remove a transaction after one verification. A five-second internal sweep finds expired transactions and performs the same hash-safe rollback; `dispose()` clears the sweep timer and pending map after requesting one final non-blocking sweep.

Instantiate one service in `apply()`, dispose it with `ctx.effect`, and register POST-only text-edit and text-verify handlers. The start body is:

```json
{
  "selectedFolder": "src",
  "selection": {
    "pageUrl": "http://localhost:5173/",
    "framePath": [],
    "selector": "h1",
    "fingerprint": "h1|0",
    "displayedText": "旧标题",
    "tagName": "h1",
    "attributes": {},
    "nearbyText": []
  },
  "replacementText": "新标题"
}
```

Add route-registration expectations for `/workspace/text-edit` and `/workspace/text-verify`.

- [ ] **Step 4: Run transaction, resolver, and route tests**

Run:

```powershell
npm run build
node --import tsx --test tests/direct-text-edit.test.ts tests/source-text-resolver.test.ts tests/plugin.test.ts
```

Expected: all tests PASS; the conflict test proves external edits are never overwritten.

- [ ] **Step 5: Commit direct edit transactions**

```powershell
git add plugins/dsh-frontend-feedback/src/direct-text-edit.ts plugins/dsh-frontend-feedback/src/index.ts plugins/dsh-frontend-feedback/tests/direct-text-edit.test.ts plugins/dsh-frontend-feedback/tests/plugin.test.ts
git commit -m "feat: verify and roll back direct text edits"
```

---

### Task 11: Connect direct text editing to the workspace preview

**Files:**
- Modify: `plugins/dsh-frontend-feedback/src/client/workspace.tsx`
- Modify: `plugins/dsh-frontend-feedback/src/client/index.tsx`
- Modify: `plugins/dsh-frontend-feedback/src/annotator-script.ts`
- Modify: `plugins/dsh-frontend-feedback/tests/plugin.test.ts`

**Interfaces:**
- Consumes: text selection and verification messages from Task 8 and two-phase APIs from Task 10.
- Produces: the non-Agent direct text user flow, preview verification timeout, source-file reveal, and shared annotation fallback.

- [ ] **Step 1: Add failing bundle behavior assertions**

```ts
test('client bundle uses two-phase direct text editing without queuing Agent feedback', async () => {
  const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(bundle, /workspace\/text-edit/)
  assert.match(bundle, /workspace\/text-verify/)
  assert.match(bundle, /修改文字/)
  assert.match(bundle, /转为评注/)
  assert.doesNotMatch(bundle, /文字已直接写入 deck\.json/)
})
```

Keep the existing assertion that normal feedback still calls the PageCraft feedback transport.

- [ ] **Step 2: Build and verify the legacy deck-only code fails the assertions**

Run:

```powershell
npm run build
node --import tsx --test tests/plugin.test.ts
```

Expected: FAIL because `saveSelectedText()` still writes `deck.json` directly and verification endpoint usage is absent.

- [ ] **Step 3: Implement the complete direct-text UI state machine**

In `PageCraftWorkspace`, add:

```ts
type DirectTextState =
  | { phase: 'idle' }
  | { phase: 'selected'; selection: DomTextSelection; replacement: string }
  | { phase: 'writing'; selection: DomTextSelection; replacement: string }
  | { phase: 'verifying'; selection: DomTextSelection; transaction: DirectTextEditStart }
  | { phase: 'result'; result: DirectTextEditResult }
```

Flow requirements:

1. **Select Text** posts annotator mode `text`.
2. `dsh-pagecraft-text-selected` opens the replacement input prefilled with displayed text.
3. **Modify Text** POSTs to `workspace/text-edit`; it never calls `sendFeedback` and never appends the annotation queue.
4. Bump preview nonce immediately after a successful start.
5. On `dsh-frontend-feedback-ready`, post `dsh-pagecraft-verify-text` with the transaction ID and original selection.
6. On `dsh-pagecraft-text-verification`, POST the boolean and observed text to `workspace/text-verify`.
7. If no verification response arrives within 8 seconds, POST `verified: false` and show the returned rollback/conflict result.
8. On committed result, open the returned file path and reveal the returned line in CodeMirror.
9. On rolled back result, refresh once more and explain that the source was restored.
10. On boundary error codes, show their plain-language messages and leave disk untouched.
11. **Turn into annotation** converts the current DOM selection to the existing `ElementSelection`, invokes the existing `onSelection`, and exposes the existing comment composer/queue.

Delete the old `saveSelectedText()` implementation from `client/index.tsx`. Share the workspace preview window with the parent through `onPreviewWindowChange`; the parent message listener accepts either the main preview window or workspace preview window so element/area annotations still enter one queue.

- [ ] **Step 4: Run build and all direct-edit regressions**

Run:

```powershell
npm run build
node --import tsx --test tests/direct-text-edit.test.ts tests/source-text-resolver.test.ts tests/plugin.test.ts
```

Expected: all tests PASS and the legacy deck-only status string is absent.

- [ ] **Step 5: Commit the direct text UI**

```powershell
git add plugins/dsh-frontend-feedback/src/client/workspace.tsx plugins/dsh-frontend-feedback/src/client/index.tsx plugins/dsh-frontend-feedback/src/annotator-script.ts plugins/dsh-frontend-feedback/tests/plugin.test.ts
git commit -m "feat: edit selected DOM text without an Agent"
```

---

### Task 12: Preserve presentation bindings, remove legacy tree code, document boundaries, and verify end to end

**Files:**
- Create by rename: `plugins/dsh-frontend-feedback/src/presentation-project.ts`
- Delete after extraction: `plugins/dsh-frontend-feedback/src/source-workspace.ts`
- Modify: `plugins/dsh-frontend-feedback/src/presentation-workspace.ts`
- Modify: `plugins/dsh-frontend-feedback/src/index.ts`
- Modify: `plugins/dsh-frontend-feedback/skills/presentation-builder/SKILL.md`
- Modify: `plugins/dsh-frontend-feedback/README.md`
- Modify: `plugins/dsh-frontend-feedback/README.zh-CN.md`
- Modify: `plugins/dsh-frontend-feedback/lib/index.js`
- Modify: `plugins/dsh-frontend-feedback/lib/client.js`
- Modify: `plugins/dsh-frontend-feedback/tests/plugin.test.ts`

**Interfaces:**
- Consumes: complete generic workspace and direct-edit flows from Tasks 1–11.
- Produces: presentation-only project services, stable generated text bindings, updated docs, no manifest-shaped Explorer code, and a green package check.

- [ ] **Step 1: Add regression assertions for stable text keys and removed legacy tree behavior**

```ts
test('presentation skill requires stable editable text bindings', () => {
  assert.match(skills[1]?.content ?? '', /data-pagecraft-text-key/)
  assert.match(skills[1]?.content ?? '', /slide-03\.title/)
})

test('workspace bundle no longer builds a manifest-shaped source tree', async () => {
  const host = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(host, /function treeFromPaths/)
  assert.doesNotMatch(host, /文件不在可编辑清单中/)
  assert.match(host, /pagecraft-presentation\.json/)
  assert.match(host, /bindPresentationProjectAsset/)
})
```

- [ ] **Step 2: Run and verify legacy implementation fails cleanup assertions**

Run:

```powershell
npm run build
node --import tsx --test tests/plugin.test.ts
```

Expected: FAIL on the old manifest tree functions and missing explicit skill requirement.

- [ ] **Step 3: Extract presentation-only code and remove obsolete endpoints**

Move only these responsibilities from `source-workspace.ts` into `presentation-project.ts`:

- PageCraft presentation manifest read/normalization;
- legacy job-to-project migration still required by existing generated tasks;
- presentation project image listing/read/upload/delete;
- image-key-to-deck binding;
- project asset public URL generation.

Delete these obsolete manifest-shaped responsibilities instead of copying them:

- `treeFromPaths()` and directory discovery for Explorer;
- `editableFiles` gating for generic file reads;
- presentation-only source save/create/rename/delete/history wrappers;
- old workspace summary/tree/file/entry/history/restore host routes.

Remove the matching legacy `PresentationWorkspaceFile`, `PresentationWorkspaceTreeEntry`, `PresentationWorkspaceHistoryEntry`, `PresentationWorkspaceSummary`, layout-storage helper, and old route constants from `presentation-workspace.ts`. Update the route-registration test so the six deleted legacy routes are absent.

Keep `/presentation-workspace/asset`, `/presentation-workspace/bind-asset`, and `/presentation-workspace/migrate` until their callers are migrated; rename their internal imports to `presentation-project.ts`. The generic `/workspace/*` routes own all file-manager behavior. Delete `source-workspace.ts` with `apply_patch` after the extraction so an initially untracked working-tree file is handled safely.

Update `presentation-builder/SKILL.md` with this exact generation rule:

```markdown
Every user-visible editable text node must carry a stable `data-pagecraft-text-key`.
Use `<slide-id>.<field>` for `title`, `subtitle`, `eyebrow`, `body`, and `takeaway` fields, for example `data-pagecraft-text-key="slide-03.title"`.
The key must resolve to the owning value in the generated deck data; do not reuse one key for multiple visible nodes.
```

- [ ] **Step 4: Rewrite README sections around user outcomes and honest boundaries**

In both README files, describe:

- Open Folder shows the exact selected local subtree.
- PageCraft and VS Code/Agent edit the same real files.
- External changes appear automatically; Refresh is the recovery action.
- Dirty drafts produce conflicts and are never overwritten.
- Select Text updates common local frontend sources without an Agent.
- Dynamic/API/database/cross-origin/ambiguous text is not guessed.
- Existing element and area annotations remain the path for layout and visual work.

Remove statements that imply the manifest defines the visible file tree or that every website's source can always be rewritten.

- [ ] **Step 5: Run the complete quality gate**

Run:

```powershell
cd plugins/dsh-frontend-feedback
npm run check
```

Expected:

- host and client bundles build;
- every `tests/**/*.test.ts` test passes;
- `npm pack --dry-run` includes `lib/index.js`, `lib/client.js`, both skills, and both README files;
- no open test handle from file watchers or SSE timers;
- no absolute user-machine path appears in README or packed output.

- [ ] **Step 6: Perform one manual local acceptance pass**

Run DSH from its existing source checkout, install/link the current plugin build using the repository's established local plugin flow, then verify this exact checklist in a disposable workspace:

```text
[ ] Open a nested folder and compare every visible path with File Explorer.
[ ] Add an image externally; confirm it appears under its physical parent.
[ ] Edit a clean open file externally; confirm PageCraft reloads it.
[ ] Make a dirty PageCraft draft, edit the same file externally, and confirm a conflict appears.
[ ] Select static HTML text, modify it, and confirm both source and preview change.
[ ] Select PageCraft PPT title text and confirm its keyed deck value changes.
[ ] Select ambiguous repeated text and confirm no source file changes.
[ ] Force a preview verification failure and confirm the original file returns.
[ ] Select an element and an area in workspace preview; confirm both use the existing shared queue.
[ ] Restart DSH and confirm the selected folder and column layout restore.
```

- [ ] **Step 7: Commit cleanup and documentation**

```powershell
git add plugins/dsh-frontend-feedback/src/presentation-project.ts plugins/dsh-frontend-feedback/src/presentation-workspace.ts plugins/dsh-frontend-feedback/src/index.ts plugins/dsh-frontend-feedback/skills/presentation-builder/SKILL.md plugins/dsh-frontend-feedback/README.md plugins/dsh-frontend-feedback/README.zh-CN.md plugins/dsh-frontend-feedback/tests/plugin.test.ts plugins/dsh-frontend-feedback/lib/index.js plugins/dsh-frontend-feedback/lib/client.js
git commit -m "refactor: unify PageCraft around the real workspace"
```

---

## Final review gate

Before pushing or opening a PR:

```powershell
git status --short
git log --oneline --decorate -15
cd plugins/dsh-frontend-feedback
npm run check
```

Confirm that only intended PageCraft files are part of the implementation commits, pre-existing `.tmp`, `eval`, archive files, and unrelated user changes remain untouched, and `lwm_dev` contains no DeepSeek Harness source modification.
