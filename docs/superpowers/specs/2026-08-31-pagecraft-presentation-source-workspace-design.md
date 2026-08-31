# PageCraft Presentation Source Workspace Design

## Summary

PageCraft will add a presentation-scoped source workspace for decks generated or migrated into the PageCraft presentation format. The workspace will let users inspect and edit presentation data, components, theme files, and static images without exposing the rest of the project.

The primary goal is persistent source-level editing. Text changes and image replacements must modify project files so the PageCraft iframe, a normal browser tab, and a future standalone export all render the same result. Preview-only DOM and asset overrides are not an acceptable source of truth.

## Goals

- Provide a collapsible, resizable workspace with a file tree, code editor, and live preview.
- Restrict file access to an explicit presentation manifest and presentation-owned directories.
- Save text and source edits directly to project files with conflict detection and atomic writes.
- Copy uploaded images into the project's public asset directory and persist their references in `deck.json`.
- Support direct text and image editing through stable DOM-to-data keys.
- Refresh or hot-reload both PageCraft and normal-browser previews after a save.
- Migrate existing PageCraft decks and preview-only image bindings into the persistent format when it can be done safely.
- Preserve recoverability through bounded save history and explicit conflict handling.

## Non-goals

- Reimplement VS Code or expose the entire project filesystem.
- Run arbitrary package-manager, build, or shell commands automatically.
- Infer arbitrary JSX or Vue source locations from unmarked DOM.
- Provide a general-purpose Git client, terminal, debugger, or extension marketplace.
- Support native PPTX/PDF export in this change.
- Automatically rewrite an unstructured legacy deck when the source mapping is ambiguous.

## User experience

### Layout

The presentation source workspace uses three panels:

1. A presentation-only file tree.
2. A code editor with tabs and dirty-state indicators.
3. The current PageCraft presentation preview.

The file tree can be collapsed. The editor/preview divider can be dragged, and either editor or preview can be maximized. PageCraft persists panel visibility, divider position, open tabs, and the active file per presentation and browser profile.

The first version uses CodeMirror rather than Monaco. CodeMirror provides syntax highlighting, keyboard editing, diagnostics integration, and a smaller, simpler web bundle. The design does not depend on CodeMirror-specific data structures, so the editor can be replaced later.

### File operations

Users can:

- Expand and collapse presentation directories.
- Open multiple editable files in tabs.
- Edit and save JSON, TypeScript, TSX, JavaScript, JSX, CSS, HTML, and Markdown.
- Create files and directories inside the presentation source root.
- Rename and delete non-protected presentation files.
- Upload, replace, reuse, and delete images inside the presentation asset root.
- Restore a recent saved version of a file.

The following files are protected from rename and deletion:

- `pagecraft-presentation.json`
- The configured deck data file.
- The configured theme file.

Saving is explicit through `Ctrl+S` or a Save button. Typing does not continuously write to disk or trigger compilation.

## Presentation project manifest

Every supported deck has `pagecraft-presentation.json` at the workspace root:

```json
{
  "name": "Project overview",
  "sourceRoot": "src/presentation",
  "deck": "src/presentation/deck.json",
  "theme": "src/presentation/theme.css",
  "assets": "public/pagecraft-assets",
  "publicAssetBase": "/pagecraft-assets",
  "editableFiles": [
    "src/presentation/deck.json",
    "src/presentation/slides.tsx",
    "src/presentation/theme.css"
  ]
}
```

`sourceRoot` and `assets` define the only directories the source-workspace service may expose. `editableFiles` allows a generated deck to hide internal or generated files even when they are under the source root. Newly created source files may be added to `editableFiles` through a manifest-aware operation.

Paths are workspace-relative, use forward slashes, and must not contain `..`. The server treats the manifest as configuration to validate, not as authorization by itself: every request revalidates the resolved path against the session workspace and the configured roots.

## Standard deck data contract

PageCraft-generated decks use `deck.json` as the content source of truth. The required portion of each slide is:

```json
{
  "id": "slide-04",
  "title": "总体技术架构",
  "body": "系统由三个核心模块组成。",
  "visual": {
    "type": "image",
    "src": "/pagecraft-assets/machine-a81f2c.png",
    "alt": "五轴机床主视图",
    "fit": "cover",
    "position": "50% 35%"
  }
}
```

Renderers add stable edit keys:

```html
<h2 data-pagecraft-text-key="slide-04.title">总体技术架构</h2>
<p data-pagecraft-text-key="slide-04.body">系统由三个核心模块组成。</p>
<figure
  data-pagecraft-image-key="slide-04.visual"
  data-pagecraft-image-slot="slide-04-main-visual"
  data-pagecraft-slot-label="五轴机床主视图"
>...</figure>
```

The keys identify supported fields in the known deck schema; they are not arbitrary object paths. The server locates the slide by stable ID and updates only an allowed field. Unmarked or structurally complex DOM continues to use the existing Agent feedback workflow.

## Host architecture

The plugin adds a presentation source-workspace service with five responsibilities:

1. **Manifest service** — load and validate `pagecraft-presentation.json`.
2. **File service** — list, read, create, save, rename, and delete allowed source files.
3. **Asset service** — validate images, copy content-addressed assets into the public directory, update deck references, and prevent deletion while referenced.
4. **History service** — retain bounded pre-save snapshots and restore a selected version.
5. **Migration service** — detect known legacy layouts and move preview-only PageCraft assets into the persistent project format.

These responsibilities remain separate from the preview proxy and annotation runtime. The client communicates through session-scoped Host routes; every route resolves the active session workspace on the server.

### Proposed routes

- `GET /api/frontend-feedback/presentation-workspace` — manifest and capability summary.
- `GET /api/frontend-feedback/presentation-workspace/tree` — restricted file tree.
- `GET /api/frontend-feedback/presentation-workspace/file` — file content and content hash.
- `PUT /api/frontend-feedback/presentation-workspace/file` — atomic save with base hash.
- `POST /api/frontend-feedback/presentation-workspace/entry` — create file or directory.
- `PATCH /api/frontend-feedback/presentation-workspace/entry` — rename an entry.
- `DELETE /api/frontend-feedback/presentation-workspace/entry` — delete an unprotected entry.
- `GET /api/frontend-feedback/presentation-workspace/history` — recent versions for one file.
- `POST /api/frontend-feedback/presentation-workspace/restore` — restore a selected version.
- `POST /api/frontend-feedback/presentation-workspace/asset` — upload and optionally bind an image.
- `DELETE /api/frontend-feedback/presentation-workspace/asset` — delete an unreferenced image.
- `POST /api/frontend-feedback/presentation-workspace/migrate` — run an eligible legacy migration.

Entry creation, rename, and deletion share one exact route and dispatch by HTTP method. All other operations use the exact routes listed above so client and Host contracts remain stable.

## Safe file access

- Require a valid DSH session with an absolute workspace directory.
- Resolve every requested path from the workspace root, never from a client-provided absolute path.
- Reject empty paths, `..`, drive-qualified paths, network paths, control characters, and disallowed extensions.
- Resolve existing files with `realpath` and verify they remain inside the permitted roots.
- For new targets, resolve and validate the real parent directory before creation.
- Reject symlinks that leave the permitted roots.
- Hide binary files from the text editor except supported image assets.
- Limit editable text files to 2 MiB by default and image uploads to the existing configured asset limit.
- Apply an allowlist for text extensions and verified image signatures.
- Protect manifest, deck, and theme files from rename/deletion.

## Save, conflict, and recovery flow

Reading a file returns its content and SHA-256 content hash. Saving sends:

```json
{
  "path": "src/presentation/deck.json",
  "baseHash": "...",
  "content": "..."
}
```

The Host service:

1. Revalidates the path and size.
2. Reads the current file and compares its hash with `baseHash`.
3. Returns HTTP 409 with the latest content/hash when another actor changed the file.
4. Validates JSON before accepting JSON files.
5. Stores the previous content in bounded history.
6. Writes the new content to a temporary sibling file and atomically replaces the target.
7. Returns the new hash and modification time.

On a conflict, the client offers:

- View differences.
- Load the latest disk version.
- Keep the user's version through an explicit overwrite request based on the latest hash.

The service retains the most recent 20 saved versions per file by default under PageCraft's workspace metadata. History is bounded by both count and total bytes. Restoring a version uses the same conflict and atomic-write path as a normal save.

JSON syntax errors block saving and identify the error offset/line. TSX and CSS are written atomically but may still fail in the project's development server; PageCraft keeps the user's edit and exposes the build/preview failure, allowing the user to fix it or restore history.

## Persistent image flow

New uploads no longer use preview injection as their final storage path.

1. Validate PNG, JPEG, WebP, or GIF content and dimensions.
2. Hash the content and create a stable filename such as `machine-a81f2c.png` inside the configured public asset directory.
3. Reuse the existing file when the content hash already exists.
4. Update the selected slide's `visual` object in `deck.json` using the same conflict-safe save service.
5. Store `src`, `alt`, `fit`, and `position` in the project data.
6. Let the development server hot-reload the project; request a PageCraft iframe refresh if no update is observed.

Deleting an image scans the standardized deck data. The operation returns a conflict while any slide references the image. Replacing an image updates the deck first and only removes an old unreferenced file through a separate explicit action.

Because the image URL belongs to the project, direct browser tabs and future standalone HTML output resolve the same asset without PageCraft or DSH runtime injection.

## Refresh and build behavior

PageCraft does not execute arbitrary project commands. It assumes the user or Agent has already started the development server.

After a successful save:

- Vite/React or another active development server may update through its normal HMR behavior.
- PageCraft waits briefly for the preview runtime to report a DOM/deck update.
- If no update arrives, PageCraft performs one controlled iframe refresh.
- If the preview becomes unavailable, PageCraft retains the saved source and shows that the development server must be started or repaired.
- Compilation errors remain visible and do not cause silent source rollback.

## Legacy migration

When a presentation lacks a valid manifest, PageCraft displays a read-only explanation and a **Migrate to editable PageCraft project** action.

### Automatic migration

Automatic migration is allowed only when PageCraft can unambiguously identify:

- One deck data file with stable slide IDs.
- One slide renderer or entry file.
- One theme file, or enough information to create a default `theme.css` inside the presentation source root.
- A project public/static directory.

The migration creates a default theme file when the legacy deck has none, creates the manifest, normalizes image fields where safe, copies existing preview-only assets from `.pagecraft/presentations/<job>/assets/` into the public asset directory, writes project-relative image references, and preserves the old PageCraft metadata for rollback.

### Agent-assisted migration

If the structure is ambiguous, PageCraft does not guess or rewrite source. It offers a one-time Agent request that reorganizes the deck into the standard manifest and deck schema. After that migration, normal text, image, and source edits do not require the Agent.

## Client state

Browser-local state is presentation-scoped and includes:

- File-tree expansion.
- File-tree visibility.
- Editor/preview split percentage.
- Current focus mode: split, editor-only, or preview-only.
- Open tabs and active file.

Unsaved file buffers remain in memory and are marked dirty. Closing the workspace, switching presentations, refreshing DSH, or accepting a disk version prompts before discarding dirty buffers. Durable source state always comes from project files, not browser storage.

## Error handling

- Invalid/missing manifest: show setup or migration state; do not expose a filesystem browser.
- Disallowed/out-of-root path: return 403 and log a concise diagnostic without leaking unrelated paths.
- Missing file: remove stale tab after confirmation or allow recreating it.
- File changed externally: return 409 and offer the conflict flow.
- Invalid JSON: reject before disk write with a line/column message.
- Partial I/O failure: leave the original target unchanged and clean the temporary file when possible.
- Asset in use: return 409 with referencing slide IDs.
- Unsupported/corrupt image: reject without copying it into the project.
- Development server unavailable: preserve successful source writes and show a preview recovery action.
- Migration ambiguity: require Agent-assisted migration rather than guessing.

## Testing strategy

### Unit tests

- Manifest normalization and rejection.
- Workspace-relative path checks, traversal attempts, Windows drive/UNC paths, and symlink escape.
- File extension and size limits.
- Hash conflict detection and explicit overwrite semantics.
- JSON validation, atomic write behavior, bounded history, and restoration.
- Image signature/dimension validation, content deduplication, project filename generation, and reference protection.
- Stable text/image key parsing and allowed deck-field updates.
- Migration eligibility and refusal when ambiguous.

### Integration tests

- Build a temporary standard presentation project, list its tree, edit `deck.json`, and verify the disk result.
- Simulate an Agent modifying an open file and verify HTTP 409 without data loss.
- Upload and bind an image, then verify it exists under the public directory and `deck.json` contains the public URL.
- Migrate a known legacy task and verify preview-only assets become persistent project assets.
- Confirm protected files cannot be renamed/deleted and ordinary component files can.

### Client and package tests

- File-tree restriction, tab/dirty state, save shortcut, and conflict dialog.
- Collapsible tree, resizable split, focus modes, and persisted layout preferences.
- Asset replacement updates source-workspace state instead of only posting iframe bindings.
- Preview refresh fallback after save.
- Plugin build, test suite, and package-content checks.

### Manual acceptance

1. Generate a new PageCraft HTML/React presentation.
2. Open the source workspace and change a title in `deck.json`.
3. Save without invoking the Agent and observe the PageCraft preview update.
4. Replace a slide image and adjust its fit/focal position.
5. Open the presentation directly in a normal browser and confirm the same title and image are visible.
6. Restart DSH and confirm the source files, image, open tabs, and panel layout are restored.
7. Trigger a concurrent Agent edit and verify PageCraft prevents an accidental overwrite.

## Rollout

1. Add shared manifest/deck contracts and the restricted Host file service.
2. Add the file tree, CodeMirror editor, save/conflict/history behavior, and layout persistence.
3. Replace preview-only image binding for standard decks with project asset write-back.
4. Add stable DOM edit keys and direct text/image controls.
5. Add safe automatic migration for recognized legacy decks and Agent-assisted fallback.
6. Update the presentation-builder Skill, README files, compiled plugin artifacts, and tests.

## Acceptance criteria

- The workspace exposes only declared PageCraft presentation files and asset directories.
- A user can edit and save supported presentation source files without an Agent turn.
- Concurrent external edits cannot be overwritten silently.
- Image uploads are stored under the project public directory and referenced by `deck.json`.
- PageCraft iframe and direct-browser presentation display the same saved text and images.
- Panel layout and open-file state survive a DSH restart.
- Legacy projects are migrated only when safe; ambiguous projects require a one-time Agent migration.
- All file, asset, migration, client, build, and package tests pass.
