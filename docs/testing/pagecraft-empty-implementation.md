# PageCraft empty preview implementation

## Scope

Implemented Task 4 from `docs/superpowers/plans/2026-09-05-browser-fixes.md` in the shared `dsh-frontend-feedback` package. Existing uncommitted presentation and direct-text-edit work was preserved.

## Changes

- The default preview URL is now `null`; a new session restores `{ entries: [], index: -1 }` instead of automatically opening `http://localhost:5173`.
- Persisted valid HTTP(S) history remains supported. Invalid or empty legacy URL values now fall back to an empty preview.
- Restored entries pointing at the current PageCraft host are filtered before mounting. Equivalent loopback names (`localhost`, `*.localhost`, `127.0.0.1`, `0.0.0.0`, and IPv6 loopback) are treated as the same host when protocol and effective port match.
- Explicit URL submission still opens a current-host target and displays a loop-warning status.
- The main preview and file-workspace preview do not mount an iframe while no target exists. Both show an empty state; file browsing and editing remain available.
- Preview-only refresh and selection controls are disabled with no target.
- Presentation callbacks continue to populate the URL through the existing explicit navigation path when a generated presentation reports `previewUrl`.
- The new history/current-host helpers are exported from the same package entry point, preserving DSH/PageCraft package compatibility.

## Tests

Command:

`npm --prefix plugins/dsh-frontend-feedback run check`

Result: passed.

- Build completed.
- 53 tests passed, 0 failed/skipped/cancelled.
- Added coverage for empty and invalid history, valid legacy fallback, current-host and loopback-alias suppression, non-host history preservation, and different-port navigation.
- Package dry-run completed with the expected eight published files.

## Generated output

The required package build updated `plugins/dsh-frontend-feedback/lib/client.js` and `plugins/dsh-frontend-feedback/lib/index.js`. Those files were already dirty because of pre-existing PageCraft work; the build intentionally includes both that work and this fix.

## Remaining integration check

A clean-session browser acceptance pass was not run in this isolated Task 4 implementation. The root integration owner should confirm the initial empty state, file editor operation without a URL, explicit self-target warning, back/forward restoration, and presentation-provided URL in the final browser pass.
