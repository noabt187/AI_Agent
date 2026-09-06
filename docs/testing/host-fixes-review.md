# Host six-fix review

## Scope

Read-only review against `docs/superpowers/specs/2026-09-05-browser-fixes-design.md`, excluding the API contract analyzer. Reviewed command execution, directory browsing, session drafts, run persistence/cancellation, orchestrator signal integration, and Web timeline integration.

## Re-review of prior findings

No remaining actionable defects were found in the two corrected areas.

### Prior P1 — resolved

The queue-owned request signal is now installed for the full `handleUserInput` lifetime and checked at entry, exit, after directory setup, around emitted output and persistence, after interactive directory/confirmation waits, and before later dispatch or mutation (`src/orchestrator/orchestrator.ts:76-94`, `src/orchestrator/orchestrator.ts:147-225`, `src/orchestrator/orchestrator.ts:301-326`). Agent execution still combines it with the turn-local controller (`src/orchestrator/orchestrator.ts:237-249`).

Context compression now receives the signal in the LLM stream and checks it before history backup/save mutations (`src/context/contextCompressor.ts:123-218`). `/revert` now uses argv-based, abortable `runCommand` calls for fetch, diff, and checkout and checks cancellation after confirmation (`src/orchestrator/orchestrator.ts:409-469`). The new abort tests cover cancellation during directory setup and pre-aborted compression (`tests/orchestrator-abort.test.ts`).

This provides forward cancellation: once cancellation is observed, no later step is dispatched. As expected for this architecture, it does not transactionally roll back a filesystem, network, or memory side effect that completed before the abort was observed.

### Prior P2 — resolved

The run lifecycle collector now saves the last non-empty partial before clearing the current model segment at a tool call and uses that retained value when a cancelled/failed segment has no later content (`src/server/sessionApi.ts:92-128`). It also persists message associations at lifecycle boundaries rather than waiting only for terminal completion.

The lifecycle regression now exercises the reported sequence—delta, tool call, blocked tool, abort—and verifies that the cancelled record retains the pre-tool partial and reaches durable terminal state before its FIFO successor starts (`tests/session-run-lifecycle.test.ts:7-49`).

## Areas that passed inspection

- Drafts are isolated by session and stored in `sessionStorage`; acceptance clears only the captured revision, so edits made while submission is in flight survive (`web/src/sessionDrafts.ts`, `web/src/App.tsx:1260-1276`). HTTP acceptance happens only after the queued run record has been durably created (`src/server/sessionApi.ts:80-87`, `src/server/sessionApi.ts:124-137`, `src/server/coreRoutes.ts:270-284`).
- Run snapshots are serialized per session and written through temporary-file rename; terminal records reject later status overwrites (`src/state/runStore.ts:40-89`). Startup recovery converts leftover queued/running records to `interrupted`.
- Queue abort signals the active request, waits through durable `onFinish`, and does not remove later FIFO requests (`src/server/promptQueue.ts:47-53`, `src/server/promptQueue.ts:78-112`).
- The abort HTTP response is not returned until the active queue item and its terminal run update settle (`src/server/sessionApi.ts:393-395`).
- Directory-picker requests are session-owned and revision-gated, preventing stale responses from overwriting a switched or closed picker (`web/src/App.tsx:916-977`). Server validation requires existing absolute directory paths (`src/server/sessionApi.ts:294-301`).
- Windows npm/npx execution uses argv-based Node CLI invocation, keeps start/exit/timeout/abort/output-limit classifications, and terminates the process tree on stop (`src/utils/command.ts`).
- Legacy sessions without run records retain their old timeline format; durable run status and recovered partials are merged only when records exist (`web/src/sessionTimeline.ts`).

## Verdict

- **Spec verdict: pass.** The corrected whole-request cancellation path and tool-boundary partial recovery now satisfy item 6, alongside the previously passing host fixes.
- **Quality verdict: pass.** Both prior findings have targeted regression coverage. The read-only integration fixture's move to an ephemeral port is consistent with reliable test isolation and does not alter production behavior.
