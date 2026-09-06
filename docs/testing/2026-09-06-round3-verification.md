# Round 3 PageCraft editor-state verification

Date: 2026-09-06
Historical acceptance base: `3bc1af48c1f89f2c3544933a71d48574adb33f79`

## Final source fix wave (after whole-branch review)

All six final review findings are fixed in source: admission captures controls before RunStore I/O; resume rejects constraint-bearing text; CLI turns persist/reconcile run outcomes; B → base A clears obsolete editor conflicts and invalidates pending replacements; terminal QueryEngine failures reach failed-run/paused-task finalization; queue finalization commits a stable Stop boundary and pauses the owned cancelled task before the successor runs.

Focused regressions went RED before implementation (host 8 failures / 1 preservation pass; mounted B → A 2 failures / 1 legacy preservation pass), then GREEN. Final complete suites passed with explicit single-worker execution: root `node --import tsx --test --test-concurrency=1 tests/**/*.test.ts tests/**/*.test.tsx` **125/125**, and the same command from the plugin directory **106/106**. The plugin count includes concurrent image-slot tests outside this fix wave. Backend and web builds passed (1,593 modules). Plugin build and 8-file package dry-run passed separately.

The default parallel `npm test` and plugin `npm run check` attempts did not pass: this machine exhausted memory/process capacity (root log: `FATAL ERROR: AlignedAlloc Allocation failed - process out of memory`, plus `spawn UNKNOWN`; two plugin workers exited). Serialized execution changed only concurrency, not test scope. The known trust/DEP0190 and React border warnings remain.

Tested working-tree SHA-256 values, including concurrent external image-slot source/build changes:

- `plugins/dsh-frontend-feedback/src/client/source-workspace.tsx`: `24d4ec4b2a4370995fbb3a4caf864d7bf71b306980e0a3202de8108523238b4c`
- `plugins/dsh-frontend-feedback/lib/client.js`: `378654e781731c414d233d09aae02126d5e9b2ba7259cc5be6194221fa9e663b`
- `plugins/dsh-frontend-feedback/lib/index.js`: `842f6c799abf608a8ed992c7e8d026d4b04cb49fa78f22cec9cd37328c0c6667`

Only the conflict source/test/generated-client hunks belong to this fix wave; concurrent image-slot edits are preserved and excluded from its commit. The earlier artifact identity and full browser matrix farther below remain historical and do **not** validate these rebuilt bytes. The bounded final-artifact refresh below does validate the final built bytes in both hosts. Native Confirm/discard remains pending and is not waived.

## Final artifact refresh at `6868654`

The current built PageCraft was packed once to `D:\project\AI_Agent\.tmp\r3-c2\final-package\dsh-frontend-feedback-0.3.0.tgz`, SHA-256 `24efe9d2c7b8718ffe95a56ffbabc55ff85133305703282f74408c9a0ee5ab6`. The package contains 8 files (438.3 kB packed / 1.7 MB unpacked) and honestly includes active concurrent image-slot working-tree changes. Those bytes are acceptance input, not ownership by this verification commit. No rebuild occurred during the refresh because source hashes matched the final-fix report. This package hash and the 125/125 root plus 106/106 plugin results are a captured tested snapshot; further external annotator/source/test working-tree changes appeared afterward, remain outside this commit, and were not rebuilt or retested here.

Both isolated profile manifests point to that same absolute tarball. Exact source/installed equality:

```text
D:\project\AI_Agent\plugins\dsh-frontend-feedback\lib\client.js
D:\project\AI_Agent\.tmp\r3-c2\agent-home\profiles\c2-acceptance\node_modules\dsh-frontend-feedback\lib\client.js
D:\project\AI_Agent\.tmp\r3-c2\dsh-home\profiles\web\node_modules\dsh-frontend-feedback\lib\client.js
  SHA256 378654E781731C414D233D09AAE02126D5E9B2BA7259CC5BE6194221FA9E663B

D:\project\AI_Agent\plugins\dsh-frontend-feedback\lib\index.js
D:\project\AI_Agent\.tmp\r3-c2\agent-home\profiles\c2-acceptance\node_modules\dsh-frontend-feedback\lib\index.js
D:\project\AI_Agent\.tmp\r3-c2\dsh-home\profiles\web\node_modules\dsh-frontend-feedback\lib\index.js
  SHA256 842F6C799ABF608A8ED992C7E8D026D4B04CB49FA78F22CEC9CD37328C0C6667
```

Both actual hosts served identical client bytes:

```text
http://127.0.0.1:61138/plugins/dsh-frontend-feedback/client.js?rev=378654e78173
http://127.0.0.1:49451/plugins/dsh-frontend-feedback/client.js?rev=4ab432a56f7e
  Status 200; 1,393,771 bytes
  SHA256 378654E781731C414D233D09AAE02126D5E9B2BA7259CC5BE6194221FA9E663B
```

The new `final-bom-crlf.txt` began as 43 bytes, SHA-256 `862023924120676b3fec167fc4f752887e88b89124b6f3765a6522e76ca90bd0`: UTF-8 BOM, homogeneous CRLF, Chinese plus non-BMP emoji, and no terminal newline. In the actual Agent UI, append/undo restored the original clean disabled-Save state; saving `-FINAL-AGENT` produced 55 bytes and SHA-256 `1f068536765c97302cb0b417fbb98b2f9ec5e6a5c5ba7f44d0b2296657b1b4d6`. After reloading to observe the held run, the actual clean workspace close and preview-address Escape removed PageCraft while Stop stayed visible and the composer stayed disabled.

The actual DSH UI read those Agent-written bytes. Append/undo again restored a clean disabled-Save state; saving `-FINAL-DSH` produced 65 bytes and SHA-256 `381549e608a9cc025479ee2dda66dae2751f7cfc0d0466bc0354dd05ae3ea3e1`. BOM, CRLF, and no terminal newline survived both hosts. Clean workspace close and preview-address Escape removed PageCraft; the blank DSH session made no model call.

After both UI smokes, the fresh held Agent run completed durably: harness counters `started=1 completed=1 aborted=0`, and both public API and `.tmp/r3-c2/state/session-final-001/runs.json` recorded run `53b3ee74-5515-4e2e-a20e-165d86faa648` as `completed`, not cancelled. Both final test-only hosts were then stopped. This acceptance worker touched neither the user frontend on port 5173 nor its backend on port 3090. Separately, the controller recovered the stale 3090 dev watcher and verified the original 5173 PageCraft open/close flow plus session-011 history on the current client revision.

The old historical held run cannot be claimed completed: its exec process disappeared before this refresh, its last live counters were `1/0/0`, and its preserved row `fecb1e8e-6039-4af9-8e80-efb8011b9a73` still says `running`. No private mutation was used to rewrite it. Native Chrome Confirm/discard likewise remains **unverified** after the earlier automation blockage; the old browser-only draft was not erased with IndexedDB/private APIs, and disk `dirty-exit.txt` remains at SHA-256 `e6645514189956cbc087179ed881872e91cc93e9064aa0fbb4930c93177f1e38`.

Two explicit handoff rulings remain in `.superpowers/sdd/2026-09-06-pagecraft-editor-state/progress.md`: (1) the native Confirm/discard gap stays open, and a later manual defect requires another fix/retest rather than being inferred from deterministic coverage; (2) refactoring the pre-existing fixed-ID abort test is deferred. Its three cancelled `/remember should not save` rows were moved to the recoverable `.tmp/r3-c2/leftover-session-cancel-fixture` archive with no message/state/memory writes, but rerunning that older test in the same working directory may recreate the harmless test session until the fixture is isolated.

## Historical artifact identity and host assembly

PageCraft was built before acceptance, packed once as `dsh-frontend-feedback-0.3.0.tgz`, and the exact same tarball was installed into isolated AI Agent and DeepSeek Harness `web` profiles.

- Tarball SHA-256: `3fa404c7b4fe30a35f3361a4105eb8bdd6d11b10af604ac9157d401712b972d06`
- Packed files: `lib/client.js`, `lib/index.js`, `package.json`, `cordis.patch.yml`, both READMEs, and the two bundled skills (8 files total).
- `lib/client.js` SHA-256 in the source tree and both installed profiles: `b09c9525a29412018de4bab9db6ec399a77577db9745a795e45763a8d8ef17a5`.
- `lib/index.js` SHA-256 in the source tree and both installed profiles: `16f5b324a279ae54ee0494692ca6912582569ebd9b57a7130406aed0c1674450`.
- Both hosts served 1,391,375 client bytes with SHA-256 `b09c9525a29412018de4bab9db6ec399a77577db9745a795e45763a8d8ef17a5`.

The Agent profile used the real host, queue, run persistence, built web app, and an injected held constructor runner in an isolated process. The DSH profile used the source-mode launcher with an isolated `DSH_HOME`, the normal `web` profile, and no source/default-profile modifications. A blank DSH workspace/session was created through the public JSON RPC; no model request was sent.

## Historical browser results

### AI Agent

The held Agent run showed the normal running UI throughout PageCraft interaction. Escape from the preview-address input closed the actual PageCraft dialog, while Stop stayed visible and the composer stayed disabled. Closing a clean file workspace and PageCraft also left the run visibly active.

The live editor produced the following byte-level results on temporary files:

| Fixture | Browser action | Result |
| --- | --- | --- |
| BOM + CRLF | Append `C2-UNDO`, then Ctrl+Z | Original text restored and Save disabled |
| BOM + CRLF | Append `C2-SAVE`, then Ctrl+S | BOM and CRLF retained; intermediate SHA-256 `a41a9a06e72128456cfbd75781b50b1ac56f1c0e96a5152839f754ea94849ef3` |
| Pure CR | Append `C2-CR`, then save | Raw bytes `6f6e650d74776f0d43322d4352`; only CR separators retained |
| LF without final newline | Append `-C2-LF`, then save | Raw bytes `7265640a677265656e2d43322d4c46`; LF retained and no final newline added |
| Mixed endings | Attempt to edit | Explicit read-only warning, `contenteditable=false`, Save disabled, disk SHA-256 unchanged at `9a9aea3334a3987ed2a6f6b8e08658bc154b83d8c8c80ccaa6c1da3ae693e82d` |

The user's already-running `localhost:5173` server was checked read-only through the public API with a temporary empty session. It returned the current BOM-aware file representation (first code point 65279, 27 bytes, matching disk hash), so no backend restart was needed. The temporary session was deleted afterward.

### DeepSeek Harness

The isolated DSH UI loaded the same PageCraft artifact. In a blank, idle session, it loaded the Agent-edited BOM/CRLF fixture, appended and undid `-DSH-UNDO` back to a clean disabled-Save state, then appended `-DSH` and saved. Final raw bytes were `efbbbf616c7068610d0a626574610d0a43322d534156452d445348`, SHA-256 `a1a877458446284295e145dd804b73b34f190bf95043c00aaa5b3470bca44cf8`; BOM and CRLF survived both hosts. The mixed-ending fixture showed the same read-only warning and non-editable editor. A clean workspace close and preview-address Escape closed PageCraft. No DSH model call was made.

### Native dirty-close limitation

The live Chrome lane reached the native confirm after editing `dirty-exit.txt`, dismissed it, and after connection recovery showed the dirty editor and `C2-DIRTY` still intact while Stop remained visible. This verifies the native Cancel outcome. A second close reached another native confirm, but browser automation timed out while accepting it. Confirm/discard is therefore **unverified**, not passed. The disk remained at its baseline hash `e6645514189956cbc087179ed881872e91cc93e9064aa0fbb4930c93177f1e38`.

The same boundary is covered deterministically by the assembled root App test using the actual built PageCraft bundle and actual CodeMirror: Cancel keeps the dirty workspace open, Confirm closes only the file workspace, PageCraft then closes, no `/abort` request occurs, and the running Agent controls remain. This automated coverage is not represented as browser-native evidence.

## Persistence and migration coverage

- Homogeneous LF, CRLF, and CR documents round-trip with their BOM and final-newline state.
- Mixed endings retain raw content and remain read-only.
- Discard/reset clears editor undo history and the selected cached draft; later input cannot resurrect discarded text.
- Legacy matching drafts inherit disk format; mismatched drafts remain conflicts, and legacy mixed drafts keep raw content.
- Existing Agent session snapshots have been exercised through the real UI; migration backups preserve the legacy snapshots and do not re-grant authorization.

## Historical verification commands

- `npm test`: 115/115 passing.
- `npm run build`: passed.
- `npm --prefix web run build`: passed (1,593 modules transformed).
- `npm --prefix plugins/dsh-frontend-feedback run check`: build passed, 100/100 tests passed, and the 8-file package dry-run passed.
- Focused assembled exit test: 1/1 passing with clean output.
- Focused PageCraft editor/format tests: 31/31 passing; emitted the known React shorthand/longhand style warning.

The root suite also emits the existing plugin trust notice and Node `DEP0190` warning during its package-install integration. The PageCraft mounted tests retain the known React `border`/`borderTop` warning. Neither warning caused a test failure.

## Repository safety

Conduit was exercised read-only. Final `git status --short` was empty; `README.md` SHA-256 remained `eae49f05002f4e8e9032609565811aa5ab69eac88a0018e2d679bf0631fa0365` and `.gitignore` remained `4dd81f573672bc56286beb49e4618f5a42244be54d04a9903ee6240a7c9ca6c8`.

The deferred disk-B-to-base-A observation was unchanged during historical C2 acceptance; it is now fixed and covered by mounted editor regressions in the final source fix wave above.
