# DSH-Compatible Plugin Architecture Design

## Summary

Upgrade AI Agent from a mostly static application into a Cordis-based plugin host that accepts the same `dsh.bundle` and `dsh.client` package used by DeepSeek Harness. The first compatibility target is DeepSeek Harness `0.1.0-rc.5` and the existing `dsh-frontend-feedback` PageCraft package. PageCraft must keep one Node bundle, one browser bundle, one package manifest, and one Cordis patch for both hosts.

The migration preserves the existing QueryEngine, LLM clients, agent loop, tool permission checks, session persistence, memory, metrics, and repository workflows. Those capabilities move behind reversible Cordis registrations instead of being rewritten as DSH internals. Plugin management is command-line only in the first release.

## Goals

- Install the existing PageCraft package from a local path, GitHub specifier, tarball, or npm package without adding an AI Agent-specific PageCraft entry point.
- Follow the DeepSeek Harness profile model: package-manager-owned dependencies, ordered bundle layers, a user patch layer, and startup-time composition.
- Use the real Cordis lifecycle and Loader semantics, including injection waiting and reversible effects.
- Load both the Node and browser halves of a DSH web plugin.
- Turn AI Agent's HTTP routes, skills, and tools into plugin contributions while preserving their current behavior and security checks.
- Replace the old built-in preview and annotation implementation only after PageCraft passes end-to-end validation.
- Fail clearly when a plugin requires a DSH service that AI Agent does not yet provide.

## Non-Goals

- Reimplement the DSH Agent Loop, Typert RPC, ACP, remote sandbox, or DSH session event log in the first release.
- Promise compatibility with every DeepSeek Harness plugin regardless of its injected services.
- Add a plugin marketplace or browser-based plugin installer.
- Support hot installation or hot upgrade while AI Agent is running.
- Fork PageCraft or maintain a second AI Agent-specific build of it.

## Compatibility Baseline

The compatibility baseline is the plugin protocol in `D:\work\deepseek-harness` at DeepSeek Harness `0.1.0-rc.5`. AI Agent uses matching versions of:

- `@deepseek-ai/cordis`
- `@deepseek-ai/cordis-plugin-loader`
- `@deepseek-ai/cordis-plugin-include`

The first supported web-plugin service set is:

- Cordis function plugins with named `name`, `inject`, `Config`, and `apply` exports
- Cordis services, effects, dependency waiting, and teardown
- `dsh.bundle.patch` and `dsh.profile.bundles`
- `dsh.client` packages exporting `./client`
- `ctx.webServer`
- `ctx.skills`
- the documented AI Agent subset of `ctx.sessions`
- browser `ctx.slots` and browser `ctx.sessions`
- plugin-defined services that other installed plugins can inject

A package that depends on an unavailable service fails during activation with the plugin name and missing service names. AI Agent does not silently provide placeholder behavior.

## Target Architecture

```text
AI Agent CLI
  └─ Profile Manager
      ├─ pnpm dependency management
      ├─ dsh.bundle discovery
      └─ ordered Cordis patch composition
           ↓
      Cordis Plugin Host
      ├─ AI Agent Core Adapter
      ├─ WebServer Service
      ├─ Skills Service
      ├─ Sessions Service
      ├─ Tools Service
      └─ Client Module Host
           ↓
      dsh-frontend-feedback
      ├─ lib/index.js
      └─ lib/client.js
```

The implementation has five logical layers:

1. `runtime`: root Cordis Context, Loader, composition, activation audit, and teardown.
2. `profiles`: profile initialization, dependency reconciliation, bundle discovery, and patch composition.
3. `services`: DSH-compatible or AI Agent-owned registries for HTTP routes, skills, sessions, tools, and browser modules.
4. `adapters`: wrappers that expose current AI Agent orchestration and session state through those services.
5. `web runtime`: browser module loading, Cordis client context, slots, session bindings, and React rendering.

Internal capabilities can remain modules in this repository for the first release. They do not need to become independently published npm packages, but they must mount through the same Loader and lifecycle as external plugins.

## Profiles and CLI

### Home and profile layout

`AI_AGENT_HOME` selects the installation home. It defaults to `~/.ai-agent`.

```text
~/.ai-agent/
└─ profiles/
   ├─ node_modules/
   └─ web/
      ├─ package.json
      ├─ pnpm-workspace.yaml
      ├─ pnpm-lock.yaml
      ├─ cordis.yml
      ├─ cordis.patch.yml
      └─ node_modules/
```

The shared `profiles/node_modules` directory exposes the AI Agent installation's Cordis and supported DSH service packages through Node's normal parent-directory lookup. Each profile's own `node_modules` contains out-of-tree plugins installed by the user. The pnpm profile uses a hoisted linker and disables automatic peer installation so every plugin shares the host's single Cordis instance.

### Profile manifest

The `web` profile starts with the AI Agent base and web bundles. Installed bundles are appended in dependency order:

```json
{
  "name": "ai-agent-profile-web",
  "private": true,
  "dependencies": {
    "dsh-frontend-feedback": "github:noabt187/dsh-PageCraft"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@ai-agent/base",
        "@ai-agent/web-app",
        "dsh-frontend-feedback"
      ]
    }
  }
}
```

### CLI contract

```powershell
ai-agent plugin --profile web add github:noabt187/dsh-PageCraft
ai-agent plugin --profile web add D:\project\AI_Agent\plugins\dsh-frontend-feedback
ai-agent plugin --profile web update dsh-frontend-feedback
ai-agent plugin --profile web remove dsh-frontend-feedback
ai-agent plugin --profile web list
ai-agent --profile web
ai-agent --profile web --dump-config
```

The plugin subcommand initializes the profile when necessary and forwards package-manager arguments to pnpm with the profile as its working directory. Relative filesystem package specifiers are resolved against the directory from which the user invoked `ai-agent`, preventing them from being accidentally interpreted relative to the profile.

After a successful pnpm operation, reconciliation reads the actual dependency names from the profile manifest. A dependency whose package manifest declares `dsh.bundle.patch` joins the ordered bundle list. A removed dependency, or one whose new version no longer declares a bundle, leaves the list. A dependency without a bundle declaration remains installed as a normal library and produces an orientation warning.

The bundle list is unchanged when pnpm fails. Startup reads and validates every listed bundle, composes bundle patches followed by the profile's `cordis.patch.yml`, and writes or reports the effective `cordis.yml`. Patch parse failures, unresolved bundles, missing `dsh.bundle`, invalid plugin configuration, module import failures, and unsatisfied injections all fail loudly.

Plugin-set changes require an AI Agent restart in the first release. This ensures the Node and browser halves always come from the same installed package version.

## Cordis Runtime and Node Services

### Boot sequence

```text
create root Context
  → mount foundation services
  → load the composed Cordis entries
  → mount AI Agent built-in plugins
  → mount external bundle entries
  → wait for injection dependencies
  → audit activation
  → accept HTTP requests and Agent work
```

Every contribution registers through `ctx.effect()`, `ctx.on()`, or a registry method whose disposer is owned by an effect. Unloading a fiber removes its routes, skills, tools, listeners, watchers, and background work in reverse registration order. A throwing `apply()` unwinds all effects already registered by that fiber.

### Web server

The monolithic route switch in `src/server/server.ts` is split into built-in route plugins. They register through a `WebServer` service compatible with the DSH route contract:

```ts
ctx.webServer.register({
  kind: "exact",
  path: "/api/sessions",
  handler,
})
```

Existing health, session, filesystem, metrics, memory, repository, streaming, and static-web behavior stays intact. Duplicate `(kind, path)` registrations are configuration errors. PageCraft registers its `/api/frontend-feedback/*` routes without host-specific changes.

### Skills

`ctx.skills` becomes the single runtime catalog:

- A built-in provider contributes the Markdown files in `src/skills`.
- A custom provider contributes uploaded skills and persists their enabled state.
- External plugins can call `ctx.skills.register()` or register providers.
- PageCraft contributes `frontend-page-builder` and `presentation-builder` during `apply()`.
- The Agent builds its compact catalog and resolves `use_skill` through the service snapshot for the current working directory.
- Disposing a plugin removes its skills and invalidates the catalog.

Plugin-provided skills appear in the existing Skill manager as `plugin/bundled`. They are visible but cannot be deleted independently; removing the owning plugin removes them. Existing uploaded Skill management remains a provider rather than a parallel catalog.

### Sessions

The first release preserves the current session store and persistence format. A Cordis service exposes stable compatibility objects for active AI Agent sessions:

```text
ctx.sessions.get(sessionId)
  → AI Agent session adapter
      header.id
      header.createdAt
      header.cwd
```

`header.cwd` is the session's primary allowed path, `allowedPaths[0]`. The adapter owns the mapping between a live session id and its compatibility object so repeated lookups return the same object for that lifecycle.

The supported methods are documented explicitly. Calling an unsupported DSH Session capability throws `UNSUPPORTED_SESSION_CAPABILITY`; the host must not report a false success. A future migration may adopt the complete DSH SessionStore and event log, but PageCraft does not depend on that migration.

### Tools and the Agent loop

The static tool record becomes a Cordis registry service. Each tool contributes:

- its model-facing schema
- its permission scope
- its execution function
- path-bearing argument metadata
- required arguments
- an effect-owned disposer

The unified executor continues to enforce design confirmation, write permission, path containment, repository defaults, and the `auto-memory` gate. A plugin cannot bypass those checks by registering a tool. The existing Agent loop reads a per-turn registry snapshot rather than importing a static object.

The initial built-in composition includes logical entries for web server, sessions, skills, tools, orchestrator, and web app. Existing QueryEngine and LLM client code remain behind the orchestrator entry.

## Browser Plugin Runtime

### Host discovery and serving

The Node-side client-module host scans active Loader entries. For each package it:

1. Reads `package.json.dsh.client`.
2. Accepts only `platform: "web"`.
3. Resolves `exports["./client"]`.
4. Reads the built artifact and computes a short content hash.
5. Adds the plugin to the client manifest.

It exposes:

```text
GET /api/plugins/client-manifest
GET /plugins/<plugin-id>/client.js?rev=<hash>
GET /plugins/<plugin-id>/client.js.map
```

The route table maps an installed plugin id to an already-resolved artifact path. URL input never becomes a filesystem path, and only enabled client bundles can be served.

### Client module system

Before React renders the application, the Web shell fetches the client manifest and creates a DSH-compatible lazy CJS module system. It installs `window.__ModuleLoader__` before loading any plugin script. The module table seeds these platform modules:

- `react`
- `react/jsx-runtime`
- `react-dom`
- `react-dom/client`

A plugin script registers a factory through `window.__ModuleLoader__.load()`. Materialization is lazy and memoized. The loader reports duplicate ids, duplicate factory registration, missing manifest rows, missing external modules, and factory dependency cycles with the responsible plugin id.

### Browser Cordis context and slots

The browser creates its own Cordis Context and mounts slot and session services before activating external client plugins. AI Agent declares these initial slots:

- `conversation.input.left`
- `conversation.input.right`
- `conversation.input.dock`
- `conversation.input.overlay`

The input component renders registered entries in `order`. `ctx.slots.inject()` waits for a declaration, re-registers if the slot is redeclared, and removes contributions when either owner is disposed. PageCraft can therefore keep its existing registration unchanged.

### Browser session facade

PageCraft's client uses:

```ts
ctx.sessions.binding(sessionId)?.session
session.prompt(content, "queue")
session.subscribe(listener)
session.getSnapshot()
```

AI Agent provides those operations over the existing web API and session state:

- `binding(sessionId)` resolves a live Web session.
- `getSnapshot().running` reflects whether its Agent is processing a turn.
- `subscribe()` publishes running-state transitions.
- `prompt([{ type: "text", text }], "queue")` submits a normal logged user input.
- The result is `{ ok: true }` after acceptance or `{ ok: false, error }` after rejection.

The backend adds a durable-enough per-process FIFO queue for each active session. An idle session starts accepted input immediately; a running session queues it; turn completion starts the next item. PageCraft input uses the same orchestration, confirmation, abort, persistence, and output stream as normal user input.

During development Vite proxies `/api/plugins/*`, `/plugins/*`, and PageCraft API paths to the Agent server. In production the Cordis WebServer serves the shell, APIs, and plugin artifacts from one origin.

## Security Model

DSH plugins are trusted local Node and browser code, equivalent to installed npm dependencies. They are not sandboxed. Before installation, the CLI warns that a plugin may execute package scripts, register routes, read the authorized session workspace, contribute model-visible skills or tools, and run code in the AI Agent page.

Runtime enforcement remains mandatory:

- A PageCraft workspace root comes only from the selected session's `allowedPaths[0]`.
- Request parameters cannot select another session's workspace without a matching live binding.
- Client artifact URLs cannot read arbitrary profile files.
- Duplicate routes and services fail during composition.
- Every tool call passes through the host executor and permission checks.
- Patch files and relevant manifest fields are validated before activation.
- Plugin activation is transactional through Cordis effects.
- The browser and Node manifests use the same installed package and revision.
- Remote preview permissions remain controlled by PageCraft's own validated configuration.

## Error Handling and Diagnostics

Diagnostics use the command or plugin id as a prefix and preserve the stage that failed: profile initialization, pnpm, bundle discovery, patch composition, Node import, injection resolution, route registration, client artifact read, browser bundle arrival, factory materialization, slot registration, or session prompt acceptance.

`ai-agent --profile <name> --dump-config` prints the effective entry list without beginning Agent work. `ai-agent plugin --profile <name> list` reports dependency specifier, resolved package name and version, bundle status, client status, and enabled composition state.

The runtime never catches and suppresses plugin configuration or activation errors. Operational request errors are returned by the owning route in its existing response format. Disposers are containment boundaries: one cleanup failure is reported without skipping unrelated remaining cleanup.

## Migration Plan

1. Add the Cordis dependencies, profile manager, CLI, bundle reconciliation, patch composition, and configuration dump while retaining the legacy startup path.
2. Introduce effect-owned web route, skill, and tool services. Move existing behavior into built-in plugin entries without changing public APIs.
3. Add the Node client-module registry, browser module loader, browser Cordis Context, slots, and session facade.
4. Add per-session queued prompt admission required by the DSH browser session semantics.
5. Install the current local PageCraft directory into a test profile and validate Node and browser activation.
6. Validate preview, DOM annotation, area annotation, real workspace browsing, direct text editing, and presentation workflows.
7. Remove the superseded built-in preview and annotation code only after PageCraft end-to-end tests pass:
   - `src/server/preview.ts`
   - `web/src/annotationPrompt.ts`
   - the legacy preview and annotation state/UI in `web/src/App.tsx`
   - `/api/preview`
8. Update the README and development commands. Retain chat, sessions, memory, metrics, repository operations, and Skill management.

No migration step modifies the DSH repository or adds host-specific PageCraft source.

## Testing Strategy

### Unit tests

- Profile creation, invalid names, and existing-file preservation
- Relative local package specifier anchoring
- Bundle reconciliation on add, update, bundle removal, and dependency removal
- Ordered patch composition and invalid patch rejection
- Duplicate route rejection and route disposal
- Skill and tool registration, snapshot invalidation, and disposal
- Session id, lifecycle, and primary working-directory mapping
- Client manifest validation, revisioning, and path traversal rejection
- Client factory registration, React external resolution, missing modules, and cycles
- Deferred slot injection, ordering, redeclaration, and teardown
- Session FIFO ordering, rejection, abort behavior, and transition to the next queued input

### Integration tests

Use a temporary AI Agent home and install the repository's PageCraft directory into a test profile:

```powershell
ai-agent plugin --profile test add D:\project\AI_Agent\plugins\dsh-frontend-feedback
ai-agent --profile test --dump-config
ai-agent --profile test
```

The integration suite proves that:

- `dsh-frontend-feedback` appears in the effective plugin tree.
- `frontend-page-builder` and `presentation-builder` appear in the Agent skill catalog.
- PageCraft Node routes answer under `/api/frontend-feedback/*`.
- `/plugins/dsh-frontend-feedback/client.js` serves the installed client artifact.
- The AI Agent input area renders the PageCraft launcher.
- A submitted `[frontend-feedback]` work order reaches the correct session.
- PageCraft resolves the current session workspace rather than another directory.
- Removing the plugin and restarting removes its routes, skills, client manifest row, and Slot contribution.

### Regression gates

- Root TypeScript build
- Existing root test suite
- Web production build
- PageCraft's own `npm run check`
- Focused browser integration test for the PageCraft launcher and prompt handoff

## Acceptance Criteria

The work is complete when the current `plugins/dsh-frontend-feedback` package, without AI Agent-specific source or a second artifact, can be installed and run in both DeepSeek Harness and AI Agent. In AI Agent it must provide the current PageCraft Node routes, bundled skills, launcher, preview and annotation workflows, workspace tools, direct text editing, and presentation workflows. Removing it must remove all of its runtime contributions after restart, and all existing non-preview AI Agent capabilities must continue to pass their regression tests.
