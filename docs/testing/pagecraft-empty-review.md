# PageCraft empty-preview review

## Scope and evidence

Read-only review of the completed PageCraft empty-preview change against section 5 of `docs/superpowers/specs/2026-09-05-browser-fixes-design.md` and the implementation record in `docs/testing/pagecraft-empty-implementation.md`.

Reviewed the current diff and integration in:

- `plugins/dsh-frontend-feedback/src/shared.ts`
- `plugins/dsh-frontend-feedback/src/client/index.tsx`
- `plugins/dsh-frontend-feedback/src/client/source-workspace.tsx`
- `plugins/dsh-frontend-feedback/src/index.ts`
- `plugins/dsh-frontend-feedback/tests/plugin.test.ts`

The direct-text verification additions in `source-workspace.tsx` and `plugin.test.ts` were treated as pre-existing, unrelated work and were not attributed to this task.

The recorded verification result is `npm --prefix plugins/dsh-frontend-feedback run check`: build passed, 53 tests passed, and package dry-run passed. Per review instructions, the unchanged suite was not rerun.

## Findings

No actionable implementation defects found in the reviewed PageCraft empty-preview scope.

One acceptance gap remains: there is no recorded clean-session browser pass. Before final integration sign-off, manually verify initial empty rendering, opening and editing a file before any URL is supplied, explicit current-host navigation and warning, restored back/forward behavior after self-host filtering, and presentation-generated `previewUrl` navigation. This is a verification gap, not evidence of a code defect.

## Spec checks

- **Nullable navigation migration: pass.** `DEFAULT_PREVIEW_URL`, persisted URL resolution, current URL resolution, and invalid/empty history now resolve to `null` or `{ entries: [], index: -1 }` (`shared.ts:115-116`, `shared.ts:183-188`, `shared.ts:214-250`). Client draft and frame derivation handle null explicitly (`client/index.tsx:225-226`, `client/index.tsx:257-263`, `client/index.tsx:300-305`).
- **Restored self-host suppression and aliases: pass.** Detection compares protocol, effective port, exact host, or the required loopback-equivalent host set including `localhost`, `*.localhost`, `127.0.0.1`, `0.0.0.0`, and IPv6 loopback (`shared.ts:123`, `shared.ts:253-260`, `shared.ts:315-338`). Suppression is applied only while restoring persisted navigation (`client/index.tsx:181-185`); an explicit submission remains allowed and receives a loop warning (`client/index.tsx:318-329`). Different ports remain distinct.
- **No iframe in the empty state: pass.** The main preview conditionally renders an empty state instead of an iframe, and disables refresh/selection controls without a target (`client/index.tsx:655-719`). The file workspace likewise renders an empty state and no iframe while disabling preview-only actions (`source-workspace.tsx:961-978`).
- **File editor usable without a target: pass by code inspection.** Workspace loading, tree, editor, and save controls are independent of `previewSrc`; only the preview selection and refresh controls depend on it (`source-workspace.tsx:259-330`, `source-workspace.tsx:900-978`). Browser acceptance remains outstanding.
- **Presentation URL path intact: pass.** `PresentationDocumentDialog.onPreviewReady` still calls the common explicit `navigatePreview` path (`client/index.tsx:840-847`), so a generated presentation URL populates navigation from an initially empty state.
- **Shared DSH exports intact: pass.** Existing preview helpers remain exported from the same package entry point, with the two new self-host helpers added there (`src/index.ts:1257-1282`). No host-specific package fork was introduced.

## Verdicts

- **Spec verdict: pass by implementation inspection.** Section 5 is implemented as designed.
- **Quality verdict: pass with browser acceptance pending.** The nullable flow is consistently integrated, helpers are narrowly scoped and tested, and the recorded package check is green. Final end-to-end confidence still depends on the clean-session browser checks listed above.
