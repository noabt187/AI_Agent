# Web Agent Console Design

## Goal

Add a local web console for the existing command-line AI programming Agent so users can send prompts, confirm steps, interrupt runs, and view streaming output from a browser.

## Scope

The first version keeps the current CLI entry working and adds a browser entry point. It does not add authentication, multi-user support, hosted deployment, diff review, or a full file explorer.

## Architecture

- `src/orchestrator` remains the core Agent workflow.
- `src/server` exposes a local HTTP API and streaming response endpoint.
- `web` contains a Vite React app that talks to the local server.
- `scripts/orchestrator-chat.ts` remains the CLI entry.

## Backend

The server provides:

- `GET /api/health` for connectivity checks.
- `GET /api/sessions` to list saved sessions.
- `POST /api/sessions` to create a new session id.
- `GET /api/sessions/:sessionId` to load messages and orchestrator state.
- `POST /api/sessions/:sessionId/paths` to update allowed file paths.
- `POST /api/sessions/:sessionId/abort` to stop an active run.
- `POST /api/sessions/:sessionId/stream` to submit user input and stream events back.

Streaming uses newline-delimited server events over a fetch response. This keeps the first version simple while still giving the UI live output.

## Frontend

The web app provides:

- Session selector and new session button.
- Chat-style prompt input.
- Streaming assistant output.
- Buttons for common confirmation inputs.
- Allowed paths editor.
- Stop button for active runs.
- Lightweight status panel for the current session.
- Frontend preview URL input.
- Preview mode with injected element annotation.
- Element comment list.
- Batch sending annotated comments to the Agent as structured requirements.

## Frontend Annotation

The first annotation version targets local development pages from any chosen operation directory. Users enter a running frontend URL and open it through the local preview proxy. The proxy injects a small annotator script into HTML pages. When comment mode is active, the injected script highlights hovered elements and posts selected element metadata back to the console.

Each comment records the target URL, tag name, generated selector, DOM path, visible text, element rectangle, and user comment. The console turns selected comments into one structured prompt and submits it through the existing Agent stream endpoint.

The first version does not attempt to annotate nested third-party iframes, non-HTML resources, or authenticated remote pages with strict browser policies.

## Data Flow

1. User enters text in the browser.
2. Frontend posts the prompt to `/api/sessions/:sessionId/stream`.
3. Backend loads the session and calls `Orchestrator.handleUserInput`.
4. Orchestrator emits user-visible events instead of relying only on terminal output.
5. Backend streams those events to the browser.
6. Frontend appends events to the chat timeline.

## Error Handling

The backend returns JSON errors for normal API failures and emits stream `error` events for in-run failures. The frontend shows errors inline and keeps the input usable.

The preview proxy returns a clear JSON error for missing URLs, unsupported URL schemes, non-HTML content, or failed upstream preview requests.

## Verification

- TypeScript build for the root project.
- Vite production build for the frontend.
- Unit tests for preview HTML injection and annotation prompt generation.
- Manual smoke test by starting the local dev server and opening the web app.
