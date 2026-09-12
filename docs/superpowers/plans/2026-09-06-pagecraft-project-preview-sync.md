# PageCraft Project Preview Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the PageCraft file workspace, project image binding, DSH preview, and direct 8095 preview read the same project files and show the same current image.

**Architecture:** `pagecraft-presentation.json` remains the path contract. The client resolves one explicit project-or-legacy asset mode, the workspace remains rooted at the DSH project while revealing the presentation source and asset folders, and PageCraft-generated preview servers map the manifest's public image URL to its real asset directory with live reload.

**Tech Stack:** TypeScript, React 18, Node.js HTTP server, Node test runner, esbuild, JSDOM.

**Spec:** `docs/superpowers/specs/2026-09-06-pagecraft-project-preview-sync-design.md`

## Global Constraints

- Do not modify DeepSeek Harness core source.
- Preserve legacy `assets.json` support only for sessions without a valid presentation project manifest.
- Reject filesystem traversal outside the configured project, source, and asset roots.
- Do not use fixed timing delays to decide whether a completed image write is visible.
- Preserve all unrelated user changes and untracked files.

---

### Task 1: Isolate project and legacy image state

**Files:**
- Create: `plugins/dsh-frontend-feedback/src/client/presentation-asset-mode.ts`
- Create: `plugins/dsh-frontend-feedback/tests/presentation-asset-mode.test.ts`
- Modify: `plugins/dsh-frontend-feedback/src/client/index.tsx`

**Interfaces:**
- Produces: `resolvePresentationAssetMode(summary, legacyJobId): 'project' | 'legacy' | 'unavailable'`.
- Produces: one client state value that remains `checking` until the project summary request finishes.
- Consumes: `PresentationWorkspaceSummary` from `presentation-workspace.ts`.

- [ ] **Step 1: Write failing mode-selection tests**

Cover a valid manifest with a legacy job ID, an unavailable manifest with a legacy job ID, and neither source. Assert that a valid project always wins and that an unconfirmed/error state never enables legacy injection.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --import tsx --test tests/presentation-asset-mode.test.ts`

Expected: failure because `presentation-asset-mode.ts` does not exist.

- [ ] **Step 3: Implement the explicit mode resolver and client lifecycle**

Fetch the presentation workspace summary when the PageCraft presentation view opens. Keep legacy loading and `dsh-pagecraft-asset-bindings` posting disabled while checking. Enable them only after the API explicitly reports that no project workspace is available and a legacy job exists.

- [ ] **Step 4: Run focused tests and build**

Run: `node --import tsx --test tests/presentation-asset-mode.test.ts`

Run: `npm run build`

Expected: both pass.

- [ ] **Step 5: Commit the isolated asset-mode change**

Commit only the files in this task with message `fix: isolate PageCraft project image state`.

### Task 2: Align the file workspace with the real project

**Files:**
- Modify: `plugins/dsh-frontend-feedback/src/client/source-workspace.tsx`
- Modify: `plugins/dsh-frontend-feedback/src/client/workspace-state.ts`
- Modify: `plugins/dsh-frontend-feedback/src/client/index.tsx`
- Modify: `plugins/dsh-frontend-feedback/tests/workspace-state.test.ts`
- Modify: `plugins/dsh-frontend-feedback/tests/source-workspace-ui.test.tsx`

**Interfaces:**
- Produces: `expandWorkspacePath(state, path)` for expanding every directory ancestor without changing the workspace security root.
- Consumes: the resolved project manifest from Task 1.

- [ ] **Step 1: Write failing tree-state and workspace UI tests**

Assert that `.pagecraft/presentations/job` expands `.pagecraft`, `.pagecraft/presentations`, and the job directory. Assert that presentation mode opens `selectedFolder=.` even if local storage remembers a child folder, and shows the source and asset paths in the header.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --import tsx --test tests/workspace-state.test.ts tests/source-workspace-ui.test.tsx`

Expected: new assertions fail against the remembered-child-folder behavior.

- [ ] **Step 3: Implement project-root opening and source reveal**

Pass the presentation manifest into `WorkspaceExplorer`. Keep `selectedFolder` at `.` for a presentation project, load each source-root ancestor, expand that path, and display separate project/source/assets labels. Keep the normal folder picker behavior for non-presentation pages.

- [ ] **Step 4: Run focused tests**

Run: `node --import tsx --test tests/workspace-state.test.ts tests/source-workspace-ui.test.tsx`

Expected: pass.

- [ ] **Step 5: Commit the workspace alignment change**

Commit only the files in this task with message `fix: align PageCraft workspace with project root`.

### Task 3: Make image persistence refresh deterministic and report broken assets

**Files:**
- Modify: `plugins/dsh-frontend-feedback/src/client/project-assets.tsx`
- Modify: `plugins/dsh-frontend-feedback/src/annotator-script.ts`
- Modify: `plugins/dsh-frontend-feedback/src/presentation.ts`
- Modify: `plugins/dsh-frontend-feedback/src/client/index.tsx`
- Modify: `plugins/dsh-frontend-feedback/tests/annotator-script.test.ts`
- Modify: `plugins/dsh-frontend-feedback/tests/plugin.test.ts`

**Interfaces:**
- Produces: `dsh-pagecraft-image-load-error` preview message containing the failed image URL and optional slot ID.
- Consumes: the synchronous completion of `bindPresentationProjectAsset` before refreshing.

- [ ] **Step 1: Write failing image-error and bundle tests**

Dispatch an image error in the annotator DOM and assert the new message. Assert that the built project asset dialog no longer contains its fixed `setTimeout(onRefresh, 450)` call.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --import tsx --test tests/annotator-script.test.ts tests/plugin.test.ts`

Expected: failure because the error protocol and immediate refresh are absent.

- [ ] **Step 3: Implement immediate refresh and accurate error feedback**

Call `onRefresh()` directly after the binding API returns. Capture image load errors in the injected preview script and show a precise PageCraft status instead of claiming successful synchronization.

- [ ] **Step 4: Build and run focused tests**

Run: `npm run build`

Run: `node --import tsx --test tests/annotator-script.test.ts tests/plugin.test.ts`

Expected: pass.

- [ ] **Step 5: Commit the refresh and diagnostic change**

Commit only the files in this task with message `fix: verify PageCraft image refreshes`.

### Task 4: Correct current and future PPT preview servers

**Files:**
- Modify: `plugins/dsh-frontend-feedback/skills/presentation-builder/SKILL.md`
- Modify: `plugins/dsh-frontend-feedback/tests/plugin.test.ts`
- Modify: `D:\project-memo\memory-diag-pagecraft\.pagecraft\presentations\presentation-mtgz2o4n-7b777c32\server.js`
- Modify: `D:\project-memo\memory-diag-pagecraft\.pagecraft\presentations\presentation-mtgz2o4n-7b777c32\render.js`

**Interfaces:**
- Produces: `/pagecraft-assets/<file>` mapped to `D:\project-memo\memory-diag-pagecraft\public\pagecraft-assets\<file>` for the current project.
- Produces: `/__pagecraft_events` server-sent events for direct-browser reload.
- Consumes: `sourceRoot`, `assets`, and `publicAssetBase` from the project manifest contract.

- [ ] **Step 1: Add a failing Skill contract test**

Assert that the presentation Skill requires serving `sourceRoot` and mapping `publicAssetBase` to `assets`, includes traversal protection, and requires direct-preview live reload.

- [ ] **Step 2: Run the focused Skill test and verify failure**

Run: `node --import tsx --test tests/plugin.test.ts`

Expected: the new server-contract assertion fails.

- [ ] **Step 3: Update future presentation generation instructions**

Document the exact two-root route mapping and live-reload contract in the Skill without prescribing absolute user paths.

- [ ] **Step 4: Repair the current 8095 server and renderer**

Read `pagecraft-presentation.json`, map the image URL prefix to the real asset directory, reject escaped paths, watch both directories, notify connected pages, and preserve the current slide index across reload.

- [ ] **Step 5: Restart only the verified current preview process**

Resolve the PID listening on 8095 and verify its command line points at this presentation's `server.js` before stopping it. Start the same script hidden and wait until `/`, `/deck.json`, and `/pagecraft-assets/image-1-3099fec2.png` all return 200.

- [ ] **Step 6: Commit the plugin Skill change**

Commit only the plugin Skill and its tests with message `fix: define PageCraft preview asset routing`.

### Task 5: Regression and packaging verification

**Files:**
- Modify only if tests reveal an in-scope defect in files listed above.

**Interfaces:**
- Consumes: all interfaces from Tasks 1-4.
- Produces: a buildable, testable plugin and a working current 8095 preview.

- [ ] **Step 1: Run the complete plugin checks**

Run from `plugins/dsh-frontend-feedback`: `npm run check`

Expected: build, all tests, and dry-run package succeed.

- [ ] **Step 2: Verify repository diff and generated artifacts**

Run `git diff --check`, confirm no DeepSeek Harness file changed, and verify only scoped plugin files plus the committed design/plan are tracked.

- [ ] **Step 3: Verify both current preview paths**

Request the direct 8095 image URL and the PageCraft project asset API. Confirm both return the same image bytes, then reload the second slide and confirm it has a nonzero natural image size.

- [ ] **Step 4: Report the result without pushing unless requested**

List commits, tests, current-project files changed outside Git, and any DSH restart needed. Do not push to GitHub unless the user asks in a follow-up.
