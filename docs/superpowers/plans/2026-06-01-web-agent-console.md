# Web Agent Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local browser UI for the existing AI programming Agent.

**Architecture:** Keep the current Agent as the core workflow, add an event callback layer for web output, expose local HTTP endpoints from `src/server`, and add a Vite React app in `web`.

**Tech Stack:** TypeScript, Node.js HTTP server, React, Vite, fetch streaming.

---

### Task 1: Event Output Layer

**Files:**
- Modify: `src/orchestrator/agent.ts`
- Modify: `src/orchestrator/orchestrator.ts`
- Modify: `src/orchestrator/types.ts`

- [ ] Add event callback types for visible output, LLM deltas, tool calls, tool results, and errors.
- [ ] Thread callbacks through `Agent.run`.
- [ ] Thread callbacks through `Orchestrator.handleUserInput`.
- [ ] Keep existing CLI console output behavior.

### Task 2: Local Web Server

**Files:**
- Create: `src/server/server.ts`
- Create: `src/server/sessionApi.ts`
- Create: `src/server/stream.ts`
- Create: `src/server/types.ts`

- [ ] Add local HTTP routing with Node built-ins.
- [ ] Add session list, session create, session load, allowed path update, abort, and stream endpoints.
- [ ] Keep one active `Orchestrator` instance per session in memory.
- [ ] Emit stream events as newline-delimited JSON.

### Task 3: React Web App

**Files:**
- Create: `web/package.json`
- Create: `web/index.html`
- Create: `web/vite.config.ts`
- Create: `web/tsconfig.json`
- Create: `web/src/main.tsx`
- Create: `web/src/App.tsx`
- Create: `web/src/api.ts`
- Create: `web/src/styles.css`

- [ ] Build a two-column local console layout.
- [ ] Add session list and new session action.
- [ ] Add prompt composer and streaming chat timeline.
- [ ] Add allowed paths editor, confirmation buttons, and stop button.

### Task 4: Scripts and Verification

**Files:**
- Modify: `package.json`

- [ ] Add `dev`, `dev:server`, and `dev:web` scripts.
- [ ] Add required dev dependencies.
- [ ] Run root TypeScript build.
- [ ] Run frontend production build.
- [ ] Start the dev server and smoke test the UI.
