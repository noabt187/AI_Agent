# PageCraft Real Workspace and Direct DOM Text Editing Design

**Date:** 2026-08-31

**Status:** Approved design

**Target:** `plugins/dsh-frontend-feedback`

**Branch:** `lwm_dev`

## 1. Summary

PageCraft will replace its presentation-manifest-shaped source tree with a real, VS Code-like file workspace rooted in a user-selected subfolder of the current DeepSeek Harness (DSH) workspace.

The same workspace will support direct text editing from the live page: a user selects visible DOM text, enters the replacement, and PageCraft traces that text back to a local source file, updates the real file without calling an Agent, reloads the preview, verifies the visible result, and rolls back if verification fails.

This design keeps the existing annotation workflow for structural, visual, and regional changes. Direct text editing is a separate fast path for safe, repeated copy changes.

## 2. User problem

The current source workspace has two problems:

1. Its tree is assembled from `pagecraft-presentation.json`, so it can differ from the actual folder on disk. Images may appear under a logical group instead of their real directory.
2. Selecting visible text still requires the user or Agent to reason about source code. A non-programmer should only need to say what displayed text should become.

The intended mental model is simpler:

> PageCraft opens one of the project's real folders. The tree is the disk. Saving changes the disk. Clicking visible text changes the source that produced it when PageCraft can prove the mapping is safe.

## 3. Goals

- Let the user choose any subfolder inside the current DSH session workspace.
- Display the selected folder's real directory structure exactly, including images and newly created files.
- Read and write the same local files used by VS Code, the Agent, and the development server.
- Automatically reflect external file changes without requiring a full DSH restart.
- Prevent PageCraft from overwriting unsaved editor changes.
- Support text editing for PageCraft presentations and attempt it on arbitrary local frontend pages.
- Resolve common static and programmatic text chains automatically without showing source-code candidates to the user.
- Never call an Agent for direct text replacement.
- Verify the browser result after every automatic source edit and roll back on failure.
- Preserve the existing DOM annotation and free-region annotation workflows.

## 4. Non-goals and boundaries

- PageCraft will not browse arbitrary locations outside the current DSH workspace.
- It will not guarantee source tracing for every possible frontend runtime.
- It will not modify text that comes only from a database, remote API, server-rendered response, opaque generated bundle, canvas, image, or cross-origin page.
- It will not ask a non-programmer to choose between code locations.
- It will not silently guess when multiple source locations are equally plausible.
- It will not replace a full IDE debugger, Git client, build system, or language server.
- `pagecraft-presentation.json` may continue to describe presentation data and asset bindings, but it will no longer define or reorder the file tree.

## 5. User experience

### 5.1 Opening a real folder

The source workspace toolbar contains **Open Folder**. It opens a folder picker whose root is the current session's absolute `cwd`. Only directories below that root are selectable.

After selection:

- the left column shows the selected subtree exactly as it exists on disk;
- folders are expanded lazily;
- the chosen relative folder is remembered per DSH workspace;
- reopening PageCraft restores the same folder if it still exists;
- a breadcrumb shows the path relative to the DSH workspace;
- **Refresh** performs a full reconciliation with disk.

The tree supports create, rename, delete, and refresh. Deletion always requires confirmation. Operations on symlinks that escape the workspace are rejected.

### 5.2 Editing files

The center column uses the existing CodeMirror editor.

- Supported text files open as editable text.
- Images open in a preview with path, type, dimensions, and file size.
- Unsupported binary files show metadata and are not decoded as text.
- `Ctrl/Cmd+S` writes the open file to its actual disk path.
- A successful save updates the known content hash and preserves a bounded local history.
- If the disk changed after the file was opened, PageCraft shows a conflict instead of overwriting it.

### 5.3 Directly changing visible text

The toolbar contains **Select Text** alongside **Select Element** and **Select Area**.

The user flow is:

1. Click **Select Text**.
2. Click text in the live preview.
3. Enter the new displayed text.
4. Click **Modify Text**.
5. PageCraft finds and updates the source, reloads the preview, and verifies the visible text.

On success, PageCraft opens the changed file at the edited line and reports that the preview was verified. The user never sees or chooses source-code candidates.

If the text cannot be mapped safely, PageCraft explains the boundary in ordinary language and performs no write. Examples:

- "This text is loaded from a remote API, so PageCraft did not change a local file."
- "Several source locations could produce this text, so PageCraft did not guess."
- "The source is outside the opened folder. Open its parent folder and try again."
- "The page changed after saving, but the selected text did not. The source file was restored."

### 5.4 Direct edit versus annotation

When selected DOM content is pure text, direct editing is the default action. The panel also offers **Turn into annotation** for requests that need Agent reasoning, such as typography, layout, or rewriting multiple components.

Normal DOM selection and area selection continue to use the existing comment composer and shared feedback queue. PageCraft must not create a second annotation queue inside the source workspace.

## 6. Workspace architecture

### 6.1 Trust boundary

The browser cannot and should not read the local disk directly. The PageCraft host plugin is the file-system authority.

```text
PageCraft React UI
    | authenticated session-scoped HTTP/SSE
    v
WorkspaceExplorerService in the host plugin
    | validated absolute paths
    v
Current DSH session cwd and selected subfolder
```

Every request contains the DSH `sessionId`. The host resolves that session's `header.cwd`; the client never supplies an unrestricted absolute root.

### 6.2 Selected folder identity

The client stores only a normalized relative path from the session `cwd`. The host resolves and validates it on every operation.

Validation rules:

- reject absolute paths from client input;
- normalize separators to `/` at the API boundary;
- reject `..` traversal;
- compare resolved paths against the real workspace root;
- reject symlink traversal outside the root;
- reject reads and mutations when the selected folder no longer exists.

Client persistence uses a key derived from the normalized workspace root so two DSH workspaces do not reuse each other's folder selection.

### 6.3 Lazy real tree

The host exposes directory listing rather than returning the entire project recursively.

Each entry contains only file-system facts:

```ts
interface WorkspaceEntry {
  path: string
  name: string
  kind: 'file' | 'directory' | 'symlink'
  bytes?: number
  updatedAt: string
  textEditable: boolean
  imagePreviewable: boolean
}
```

No manifest category is allowed to change an entry's parent. The UI sorts directories before files for presentation, but parent-child structure always follows disk.

Folders such as `.git`, dependency caches, and build outputs remain real entries. Very large or noisy folders may be collapsed by default, but they are not relocated. A small configurable ignore list may suppress watching expensive folders without changing their visible location.

### 6.4 Host service responsibilities

`WorkspaceExplorerService` owns:

- root and path validation;
- directory listing;
- text and binary metadata reads;
- atomic text writes;
- create, rename, and delete operations;
- bounded history snapshots;
- file watching and event coalescing;
- source indexing for direct DOM text edits;
- edit transaction verification and rollback coordination.

The existing presentation-specific asset and manifest services remain responsible for PPT bindings. They may call this shared service for safe disk operations but must not build a second file tree.

## 7. API design

The existing `/api/frontend-feedback/presentation-workspace/*` endpoints should evolve into session-scoped real-workspace operations. Exact route names may retain the current prefix to avoid unnecessary client churn.

Required capabilities:

| Capability | Method | Inputs | Result |
| --- | --- | --- | --- |
| Workspace summary | GET | `sessionId` | root, selected folder, watcher state |
| Browse folders | GET | parent relative path | selectable child directories |
| Select folder | POST | selected relative path | validated selection |
| List directory | GET | selected folder + directory path | direct children |
| Read file | GET | relative file path | content/metadata/hash |
| Save text | PUT | path, content, base hash | updated snapshot |
| Create entry | POST | parent, name, kind | created entry |
| Rename entry | PATCH | path, new name | renamed entry |
| Delete entry | DELETE | path | confirmation result |
| History | GET/POST | path, optional revision | list or restore |
| Watch stream | GET (SSE) | `sessionId`, selected folder | coalesced file events |
| Resolve/edit DOM text | POST | selection evidence + new text | transaction result |

All errors use stable machine codes plus user-facing Chinese messages. File contents are never returned for unsupported binary files.

## 8. File synchronization

### 8.1 Disk is the source of truth

There is no virtual copy of project files. PageCraft, VS Code, the Agent, and the development server read and write the same paths.

PageCraft therefore does not "sync two folders." It observes one folder and keeps its UI synchronized with that folder.

### 8.2 Watch strategy

The host starts one recursive watcher for the selected subtree using Node's `fs.watch` in the supported DSH Node runtime. It does not start one watcher per rendered tree node.

Watcher behavior:

- normalize create/change/delete/rename signals into PageCraft events;
- batch repeated signals for a short debounce window;
- deduplicate events caused by PageCraft's own writes;
- invalidate only affected directories and open files where possible;
- keep a monotonic event sequence so the client can detect missed events;
- expose watcher health in the workspace summary.

Because operating-system watchers can miss or merge events, PageCraft also performs:

- lightweight metadata reconciliation when the browser regains focus;
- full reconciliation when the user clicks **Refresh**;
- recovery when the SSE stream reconnects or skips a sequence number.

This follows the same general principles documented by VS Code: native recursive watching, batched Explorer refreshes, deduplication, and a manual recovery path for missed file-system events.

### 8.3 Open-file behavior

When an external tool changes a file:

- if the editor is clean, PageCraft reloads it automatically and preserves cursor position when practical;
- if the editor is dirty, PageCraft keeps the draft and shows a conflict banner;
- PageCraft never overwrites a dirty draft automatically;
- the user may compare, reload disk, or keep the draft and save after resolving the conflict.

When files or images are created, renamed, or deleted externally, expanded parents refresh automatically and retain expansion state.

## 9. Direct DOM text source tracing

### 9.1 Selection evidence

The annotator already runs inside the proxied/embedded page and can inspect selected DOM. For text editing it returns a compact evidence object:

```ts
interface DomTextSelection {
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
```

Coordinates are not used to infer source. They may remain available to the annotation overlay, but source resolution uses textual and structural evidence.

The `fingerprint` is stable enough to find the same DOM after reload: it combines safe attributes, ancestor structure, sibling position, slide identity, and normalized surrounding text. It is not presented to the model or user.

### 9.2 Resolution pipeline

The resolver attempts these stages in order and stops only when one produces a high-confidence, uniquely writable target.

#### Stage A: explicit PageCraft binding

If the DOM has a stable `data-pagecraft-text-key`, map it directly to the relevant presentation data field, such as a `deck.json` slide title or body item. This is the highest-confidence path.

#### Stage B: exact static source text

Search text files inside the selected subtree for the normalized displayed string. Supported adapters initially cover:

- HTML;
- JavaScript/TypeScript JSX and TSX;
- Vue single-file components;
- Svelte components;
- Markdown/MDX;
- JSON data and translation files.

Rank matches internally using route/file relationship, element tag, classes/ids/test attributes, nearby text, component/import references, and slide identity. A single exact match with corroborating context can be edited.

#### Stage C: common programmatic chains

Trace common local frontend data flow without executing arbitrary application code:

- a JSX/Vue/Svelte expression bound to a local string constant;
- object and array properties used by a rendered component;
- props passed through local components;
- imported local JSON or TypeScript data;
- a local translation key with one matching locale value;
- PageCraft deck/theme structures.

The implementation uses syntax parsers for supported source types and follows only statically resolvable local imports. It limits traversal depth, file count, and time.

#### Stage D: safe boundary

Do not edit when evidence points to:

- API/database/runtime-only data;
- environment variables or server rendering outside the selected folder;
- several equally plausible literals;
- computed strings that require running application logic;
- minified/generated bundles;
- cross-origin content;
- canvas/image text;
- source outside the opened subtree.

The resolver may internally record candidates for diagnostics, but the normal UI never asks the user to understand or choose them.

### 9.3 Confidence policy

Only a uniquely identified, high-confidence target can enter a write transaction. Confidence is based on independent evidence, not a single fuzzy-text score.

Examples:

- explicit text key plus valid data path: high confidence;
- one literal match plus matching route/component/DOM context: high confidence;
- one literal match with no contextual relationship in a large project: insufficient;
- two equally strong matches: ambiguous, no write.

The policy deliberately prefers a visible safe failure over changing the wrong source.

## 10. Text edit transaction

A direct text change is handled as one reversible transaction:

```text
capture selection
  -> resolve unique source target
  -> re-read file and verify base hash
  -> save original content to bounded history
  -> apply the smallest syntax-aware source edit
  -> atomically write the real file
  -> wait for preview/HMR or reload explicitly
  -> find the selected DOM by fingerprint
  -> verify the new displayed text
       success: commit result and open source line
       failure: atomically restore original file and refresh again
```

The source edit changes the smallest value node that owns the displayed string. It must not run a formatter across the entire file or rewrite unrelated syntax.

The transaction result contains:

- success/failure state;
- changed relative file and line on success;
- plain-language boundary or failure reason;
- whether rollback occurred;
- latest disk hash.

The direct-edit endpoint never submits chat input, appends feedback to the Agent queue, or consumes model tokens.

## 11. Preview verification protocol

After a write, the host/client requests a preview refresh. The embedded annotator reports when the page is ready and attempts to resolve the earlier DOM fingerprint.

Verification succeeds only when:

- the target DOM can be identified with sufficient confidence; and
- its normalized displayed text equals the requested replacement.

If the development server fails to rebuild, the page fails to load, the target disappears, or the old text remains, verification fails and the source is restored.

When rollback itself cannot be completed because the file changed again externally, PageCraft stops and reports a conflict. It must not overwrite the newer external content.

## 12. File safety and recovery

### 12.1 Optimistic concurrency

Every editable text snapshot has a SHA-256 content hash. A save or automatic edit includes the base hash. The host re-reads the file immediately before writing and rejects stale writes.

### 12.2 Atomic writes

Text writes use a temporary file in the same directory followed by an atomic replace where supported. The temporary file is cleaned on failure.

### 12.3 Bounded history

Before mutations, PageCraft saves compact revisions under its existing private history area. History is bounded by entry count and total bytes. It is recovery support, not a second working copy or Git replacement.

### 12.4 Destructive operations

- Delete requires explicit confirmation.
- Recursive directory deletion names the exact selected target.
- The workspace root and selected folder root cannot be deleted from the PageCraft tree.
- Paths are resolved again immediately before mutation.
- Source edits and file operations never cross the current DSH workspace boundary.

## 13. React workspace layout

The source workspace has three resizable columns:

```text
+------------------+---------------------------+----------------------------+
| Real file tree   | Code / image editor       | Live preview               |
|                  |                           |                            |
| exact disk paths | changed file opens here   | DOM/text/area selection    |
+------------------+---------------------------+----------------------------+
```

Each column may be collapsed or maximized. Layout and the selected folder persist per DSH workspace.

The preview toolbar owns navigation and selection controls:

- Back;
- Forward;
- Refresh;
- Select Text;
- Select Element;
- Select Area.

The file toolbar owns:

- Open Folder;
- Refresh Tree;
- New File/Folder;
- Rename;
- Delete;
- Save.

Selection overlays remain in the live preview. Direct-text state is local to the current selection; normal comments continue to use the existing durable feedback queue.

## 14. Presentation compatibility

PageCraft presentations receive two optimizations but no special file-tree illusion:

1. Generated text should carry stable `data-pagecraft-text-key` bindings whenever practical, providing deterministic direct edits.
2. Presentation images and asset slots continue to use `pagecraft-presentation.json`/deck data for binding, while the Explorer shows the real image files in their actual folders.

A project without a PageCraft manifest still receives the real Explorer and may use static/programmatic text tracing. The manifest enhances confidence; it is not required to open a folder.

## 15. Migration from the current implementation

- Keep the existing editor, conflict model, atomic writer, history limits, and path-security helpers where they remain general.
- Replace `editableFiles`, `sourceRoot`, and asset-category tree construction with lazy directory listing under the user-selected folder.
- Keep presentation-specific deck and asset binding APIs, but remove their responsibility for Explorer structure.
- Convert current full-tree loading to lazy directory requests and watcher-driven invalidation.
- Reuse the existing annotator selection transport for `DomTextSelection` rather than creating a second iframe communication layer.
- Reuse one modal/workspace entry point and one feedback queue.

## 16. Testing strategy

### 16.1 Real workspace tests

- selected tree exactly matches nested disk structure;
- images remain in their physical directories;
- lazy directory listing and sorting;
- create, rename, delete, and atomic save;
- external create/change/rename/delete events update UI state;
- clean open file reloads after external edit;
- dirty file produces a conflict and is not overwritten;
- watcher reconnect and focus reconciliation;
- selected folder/layout restoration after DSH restart;
- traversal and symlink escape rejection.

### 16.2 Source resolver tests

- static HTML text;
- React JSX/TSX literals;
- Vue and Svelte text;
- Markdown/MDX;
- JSON data and local i18n key;
- local constants, object fields, arrays, imports, and common prop chains;
- PageCraft `data-pagecraft-text-key` bindings;
- repeated identical strings with one contextually unique result;
- truly ambiguous identical strings produce no write;
- dynamic/API/runtime text produces no write;
- source outside the selected subtree produces the correct boundary.

### 16.3 Transaction tests

- successful source edit refreshes and verifies DOM;
- base-hash conflict prevents write;
- build or refresh failure rolls back;
- DOM unchanged after write rolls back;
- external edit during verification prevents destructive rollback;
- direct edit never enqueues an Agent message;
- normal element/area annotation behavior remains unchanged.

### 16.4 Browser integration tests

- select text, edit, observe changed source and preview;
- externally edit in VS Code-equivalent process and observe PageCraft update;
- add/remove an image and observe the exact file tree;
- resize/collapse/maximize all three columns;
- navigate preview back/forward and retain selected workspace folder.

## 17. Acceptance criteria

The feature is complete when all of the following are true:

1. A user can open a subfolder inside the current DSH workspace and PageCraft shows its exact real structure.
2. Saving in PageCraft changes the same file visible to external tools.
3. External file changes appear automatically, with a manual refresh fallback.
4. Dirty drafts are never overwritten by watcher updates.
5. Selecting common frontend text and entering a replacement changes the correct local source without an Agent.
6. The preview is verified after the edit; failed verification restores the original source.
7. Ambiguous, dynamic, external, or out-of-scope text is not modified and receives a clear boundary message.
8. Existing DOM and area annotation workflows continue to work through the same feedback queue.
9. Presentation asset management continues to work while image files appear only at their real disk locations.
10. No DeepSeek Harness source changes are required; the implementation remains inside the PageCraft plugin.

## 18. Reference behavior

- [VS Code File Watcher Internals](https://github.com/microsoft/vscode/wiki/File-Watcher-Internals)
- [VS Code Explorer Service](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/files/browser/explorerService.ts)
- [VS Code File Watcher Issues](https://github.com/microsoft/vscode/wiki/File-Watcher-Issues)
- [VS Code FileSystemWatcher API](https://code.visualstudio.com/api/references/vscode-api)

These references guide watcher batching, deduplication, native file-system observation, and missed-event recovery. PageCraft does not copy VS Code's full architecture; it adopts the smallest subset needed for one session-scoped local workspace.
