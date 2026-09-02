# DSH-Compatible Plugin Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade AI Agent into a Cordis-based, DSH-compatible plugin host that installs and runs the existing PageCraft package unchanged from the command line.

**Architecture:** Keep the existing QueryEngine, Agent loop, persistence, and Web application, but mount their routes, skills, tools, and session access through a Cordis plugin tree. Reproduce the DSH profile and dual-face web-plugin lifecycle: pnpm installs a bundle into a profile, the Node Loader applies its patch, and a browser module kernel activates its `./client` bundle against Slot and Session services.

**Tech Stack:** Node.js 22+, TypeScript, React 19, Vite 6, pnpm profile environments, `@deepseek-ai/cordis` 4.0.1, `@deepseek-ai/cordis-plugin-loader` 1.0.2, `@deepseek-ai/cordis-plugin-include` 1.0.6, DSH `0.1.0-rc.5` service contracts, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-02-dsh-compatible-plugin-architecture-design.md`

## Global Constraints

- Keep `plugins/dsh-frontend-feedback` host-neutral: no AI Agent-only source entry, manifest field, or second build artifact.
- Match the DeepSeek Harness plugin protocol in `D:\work\deepseek-harness` at version `0.1.0-rc.5`.
- Use one Cordis instance per process; profile plugins must resolve the host's Cordis peer through the shared fallback.
- Preserve the current QueryEngine, LLM clients, Agent behavior, session persistence format, memory, metrics, GitHub workflows, and write-confirmation rules.
- Use CLI-only plugin management in this release; do not add a plugin marketplace or installer screen.
- Apply plugin-set changes only after restart so the Node and browser halves cannot run different package versions.
- Treat installed plugins as trusted local code and print that trust warning before an add or update operation.
- Reject unavailable injected services, duplicate routes, invalid patches, invalid manifests, and missing client bundles with plugin-specific diagnostics.
- Do not remove the legacy preview implementation until the unchanged PageCraft package passes the integration gate.
- Preserve the user's existing uncommitted PageCraft changes; stage and commit only files named by each task.

---

## Planned File Structure

### New host files

- `src/plugins/types.ts` — shared profile, bundle, client-manifest, and runtime option types.
- `src/plugins/profile.ts` — AI Agent home resolution, profile initialization, bundle resolution, and ordered patch composition.
- `src/plugins/manager.ts` — pnpm forwarding, path anchoring, dependency reconciliation, and plugin listing.
- `src/plugins/host.ts` — root Cordis Context, Loader setup, built-in registration, activation audit, and disposal.
- `src/plugins/clientModules.ts` — active `dsh.client` discovery, content revisions, and safe artifact serving.
- `src/plugins/services/skills.ts` — DSH SkillRegistry installation plus built-in/custom Skill synchronization.
- `src/plugins/services/tools.ts` — effect-owned tool registry and the host permission-enforcing executor.
- `src/plugins/services/sessions.ts` — synchronous DSH Session lookup facade over live AI Agent sessions.
- `src/server/http.ts` — shared JSON parsing, JSON responses, error status mapping, and path parsing.
- `src/server/coreRoutes.ts` — existing AI Agent API handler registered as a Cordis route plugin.
- `src/server/promptQueue.ts` — per-session FIFO prompt admission and event delivery.
- `scripts/ai-agent.ts` — `ai-agent`, `ai-agent plugin`, and `--dump-config` entry point.

### New browser files

- `web/src/plugins/types.ts` — client manifest, module factory, Slot entry, and Session facade types.
- `web/src/plugins/clientModuleSystem.ts` — DSH-compatible lazy CJS factory registration and materialization.
- `web/src/plugins/slots.ts` — browser Cordis Slot service with delayed declaration injection and reversible registration.
- `web/src/plugins/sessions.ts` — browser Session bindings used by PageCraft.
- `web/src/plugins/runtime.ts` — manifest fetch, browser Cordis boot, external plugin activation, and singleton runtime access.
- `web/src/plugins/SlotOutlet.tsx` — React outlet for ordered Slot contributions.

### Existing files changed deliberately

- `package.json`, `package-lock.json`, `web/package.json` — pinned runtime dependencies and CLI metadata.
- `src/server/server.ts` — reduced to profile boot and shutdown wiring.
- `src/server/sessionApi.ts` — live-session observation and queued prompt integration.
- `src/skills/registry.ts` — file persistence becomes the managed-Skill provider store.
- `src/tools/index.ts` — exports built-in registrations; static lookups move behind the service.
- `src/orchestrator/agent.ts`, `src/orchestrator/orchestrator.ts` — accept an injected Agent capability source.
- `web/src/main.tsx` — await browser plugin runtime before rendering.
- `web/src/App.tsx`, `web/src/api.ts`, `web/src/styles.css`, `web/vite.config.ts` — Session binding, Slot outlet, plugin proxies, and legacy preview removal.
- `README.md` — new CLI, profile, trust, compatibility, and PageCraft workflow.

---

### Task 1: Pin Cordis Dependencies and Implement Profile Composition

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/plugins/types.ts`
- Create: `src/plugins/profile.ts`
- Create: `tests/plugin-profile.test.ts`
- Create: `tests/fixtures/plugins/pagecraft-like/package.json`
- Create: `tests/fixtures/plugins/pagecraft-like/cordis.patch.yml`

**Interfaces:**
- Produces: `resolveAgentHome(env?: NodeJS.ProcessEnv, userHome?: string): string`
- Produces: `resolveProfileDir(name: string, home?: string): string`
- Produces: `initProfile(dir: string, bundles: readonly string[]): void`
- Produces: `readProfileManifest(dir: string): ProfileManifest`
- Produces: `writeProfileManifest(dir: string, manifest: ProfileManifest): void`
- Produces: `healProfilesModuleFallback(installAnchor: string, home?: string): void`
- Produces: `loadProfile(name: string, installAnchor: string, home?: string): LoadedProfile`
- Produces: `composeProfileEntries(profile: LoadedProfile): EntryOptions[]`

- [ ] **Step 1: Add exact runtime dependencies**

Add these production dependencies and regenerate the root lockfile with `npm install --package-lock-only`:

```json
{
  "dependencies": {
    "@deepseek-ai/cordis": "4.0.1",
    "@deepseek-ai/cordis-plugin-include": "1.0.6",
    "@deepseek-ai/cordis-plugin-loader": "1.0.2",
    "@deepseek-ai/dsh-host-webserver": "0.1.0-rc.5",
    "@deepseek-ai/dsh-skill": "0.1.0-rc.5",
    "js-yaml": "4.2.0"
  },
  "devDependencies": {
    "@types/js-yaml": "4.0.9"
  }
}
```

Run: `npm install --package-lock-only`

Expected: `package-lock.json` records the exact direct versions above.

- [ ] **Step 2: Write profile behavior tests**

Create tests that use `mkdtemp()` and never write to the real user home:

```ts
test('initProfile creates a DSH-compatible web profile without replacing existing files', () => {
  const dir = join(tempRoot, 'profiles', 'web')
  initProfile(dir, ['@ai-agent/base', '@ai-agent/web-app'])
  assert.deepEqual(readProfileManifest(dir).dsh?.profile?.bundles, [
    '@ai-agent/base',
    '@ai-agent/web-app',
  ])
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  initProfile(dir, ['changed'])
  assert.equal(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), '[]\n')
})

test('resolveProfileDir rejects traversal and reserved module directory names', () => {
  for (const name of ['', '.', '..', '../web', 'a\\b', 'node_modules']) {
    assert.throws(() => resolveProfileDir(name, tempRoot), /invalid profile name/)
  }
})

test('composeProfileEntries applies bundle layers before the user layer', () => {
  const profile = loadProfile('test', fixtureInstallAnchor, tempRoot)
  const entries = composeProfileEntries(profile)
  assert.equal(entries.find(row => row.id === 'frontend-feedback')?.config?.requestTimeoutMs, 9000)
})

test('healProfilesModuleFallback exposes one shared Cordis package to every profile', () => {
  healProfilesModuleFallback(fixtureInstallAnchor, tempRoot)
  const link = join(tempRoot, 'profiles', 'node_modules', '@deepseek-ai', 'cordis')
  assert.equal(realpathSync(link), realpathSync(fixtureCordisDir))
})
```

- [ ] **Step 3: Run the profile tests and verify the missing-module failure**

Run: `node --import tsx --test tests/plugin-profile.test.ts`

Expected: FAIL because `src/plugins/profile.ts` does not exist.

- [ ] **Step 4: Implement profile types and validation**

Define the manifest and resolved-layer types in `src/plugins/types.ts`:

```ts
export interface DshBundleManifest { patch: string }
export interface DshProfileManifest { bundles?: string[] }
export interface ProfileManifest {
  name?: string
  private?: boolean
  dependencies?: Record<string, string>
  dsh?: { bundle?: DshBundleManifest; profile?: DshProfileManifest; client?: DshClientManifest }
}
export interface DshClientManifest {
  platform: string
  inject?: string[]
  immediately?: boolean
}
export interface ProfileLayer {
  packageName: string
  packageDir: string
  patchPath: string
  patches: PatchOptions[]
}
export interface LoadedProfile {
  name: string
  dir: string
  manifest: ProfileManifest
  layers: ProfileLayer[]
  userPatchPath: string
  userPatches: PatchOptions[]
}
```

In `profile.ts`, parse each patch file with `load(raw, { schema: entryListSchema })` from `js-yaml` and `@deepseek-ai/cordis-plugin-include`. Reject any parsed value that is not an array. Compose with `applyEntryPatches([], structuredClone(layers.flat()))`. Validate that profile names contain no slash, backslash, dot traversal, or reserved `node_modules` value.

- [ ] **Step 5: Add the DSH-compatible profile files**

`initProfile()` creates this `pnpm-workspace.yaml` exactly:

```yaml
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
```

It also creates an empty `cordis.patch.yml` and a private manifest whose initial bundle order is preserved.

Implement `healProfilesModuleFallback()` as a breadth-first walk of the installation manifest's `dependencies` and `peerDependencies`. Resolve each package from the manifest that declared it, then create one junction/symlink at `<home>/profiles/node_modules/<package-name>`. Keep a correct existing link, replace only a stale link, and reject a real file or directory occupying a managed link path. Call this function before loading any profile so out-of-tree plugins share the host's Cordis and DSH service definitions.

- [ ] **Step 6: Run focused and root checks**

Run: `node --import tsx --test tests/plugin-profile.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS with the new files included by `src/**/*.ts`.

- [ ] **Step 7: Commit the profile foundation**

```bash
git add package.json package-lock.json src/plugins/types.ts src/plugins/profile.ts tests/plugin-profile.test.ts tests/fixtures/plugins/pagecraft-like
git commit -m "feat: add DSH-compatible plugin profiles"
```

---

### Task 2: Add DSH-Style CLI Plugin Management

**Files:**
- Modify: `package.json`
- Create: `src/plugins/manager.ts`
- Create: `scripts/ai-agent.ts`
- Create: `tests/plugin-manager.test.ts`

**Interfaces:**
- Consumes: `resolveProfileDir`, `initProfile`, `readProfileManifest`, `writeProfileManifest`
- Produces: `anchorPathSpec(argument: string, cwd: string): string`
- Produces: `reconcileProfilePlugins(before: ProfileManifest, profileDir: string, installAnchor: string): PluginInventory[]`
- Produces: `runPluginCommand(profile: string, args: readonly string[], options?: PluginCommandOptions): number`
- Produces: `main(argv: readonly string[]): Promise<number>`

- [ ] **Step 1: Write path anchoring and reconciliation tests**

```ts
test('anchorPathSpec resolves only relative package paths against the invoking cwd', () => {
  assert.equal(anchorPathSpec('../PageCraft', 'D:\\work\\agent'), 'D:\\work\\PageCraft')
  assert.equal(anchorPathSpec('file:./PageCraft', 'D:\\work\\agent'), 'file:D:\\work\\agent\\PageCraft')
  assert.equal(anchorPathSpec('github:noabt187/dsh-PageCraft', 'D:\\work\\agent'), 'github:noabt187/dsh-PageCraft')
})

test('reconciliation appends real bundle dependencies and removes deleted ones', () => {
  const inventory = reconcileProfilePlugins(before, profileDir, installAnchor)
  assert.deepEqual(readProfileManifest(profileDir).dsh?.profile?.bundles, [
    '@ai-agent/base',
    '@ai-agent/web-app',
    'dsh-frontend-feedback',
  ])
  assert.equal(inventory.at(-1)?.bundle, true)
})
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --import tsx --test tests/plugin-manager.test.ts`

Expected: FAIL because `manager.ts` is missing.

- [ ] **Step 3: Implement pnpm forwarding with an injected runner**

Use this testable option boundary:

```ts
export interface PluginCommandOptions {
  cwd?: string
  home?: string
  installAnchor?: string
  run?: (command: string, args: readonly string[], cwd: string) => number
  stderr?: Pick<NodeJS.WriteStream, 'write'>
}
```

The default runner calls `spawnSync('pnpm', anchoredArgs, { cwd: profileDir, stdio: 'inherit', shell: process.platform === 'win32' })`. Print the trusted-code warning before `add`, `install`, or `update`. Reconcile only when the runner returns zero.

- [ ] **Step 4: Implement listing and diagnostics**

Each list row contains:

```ts
export interface PluginInventory {
  name: string
  specifier: string
  version?: string
  bundle: boolean
  client: boolean
  active: boolean
}
```

Resolve package roots from the profile anchor without requiring `./package.json` to be exported. A package declaring `dsh.client.platform === 'web'` is reported as a client plugin.

- [ ] **Step 5: Add the executable entry and scripts**

Add:

```json
{
  "bin": { "ai-agent": "dist/scripts/ai-agent.js" },
  "scripts": {
    "ai-agent": "tsx scripts/ai-agent.ts"
  }
}
```

`scripts/ai-agent.ts` parses these forms without a command framework:

```text
ai-agent plugin --profile <name> <pnpm-args...>
ai-agent --profile <name>
ai-agent --profile <name> --dump-config
```

Unknown flags print usage and exit `2`; pnpm failures preserve their exit code.

- [ ] **Step 6: Run focused tests and smoke the help path**

Run: `node --import tsx --test tests/plugin-manager.test.ts`

Expected: PASS.

Run: `npm run ai-agent -- --help`

Expected: prints the three accepted command forms without creating a profile.

- [ ] **Step 7: Commit CLI management**

```bash
git add package.json src/plugins/manager.ts scripts/ai-agent.ts tests/plugin-manager.test.ts
git commit -m "feat: add CLI plugin management"
```

---

### Task 3: Boot a Real Cordis Plugin Tree

**Files:**
- Create: `src/plugins/host.ts`
- Create: `tests/plugin-host.test.ts`
- Modify: `scripts/ai-agent.ts`

**Interfaces:**
- Consumes: `LoadedProfile`, `composeProfileEntries`
- Produces: `BuiltinPluginMap = Readonly<Record<string, unknown>>`
- Produces: `bootPluginHost(options: PluginHostOptions): Promise<PluginHost>`
- Produces: `startAiAgentProfile(name: string, options?: StartProfileOptions): Promise<PluginHost>`
- Produces: `PluginHost.ctx: Context`
- Produces: `PluginHost.dispose(): Promise<void>`

- [ ] **Step 1: Write lifecycle and missing-injection tests**

```ts
test('bootPluginHost loads configured builtins and disposes their effects in reverse order', async () => {
  const events: string[] = []
  const host = await bootPluginHost({
    entries: [{ id: 'probe', name: '@ai-agent/probe' }],
    baseUrl: pathToFileURL(join(profileDir, 'package.json')).href,
    builtins: {
      '@ai-agent/probe': {
        apply(ctx: Context) {
          ctx.effect(() => {
            events.push('start')
            return () => { events.push('stop') }
          }, 'probe')
        },
      },
    },
  })
  assert.deepEqual(events, ['start'])
  await host.dispose()
  assert.deepEqual(events, ['start', 'stop'])
})

test('bootPluginHost names an entry whose required service never activates', async () => {
  const missingServiceRow: EntryOptions = {
    id: 'missing-service',
    name: '@ai-agent/missing-service-probe',
  }
  const builtins: BuiltinPluginMap = {
    '@ai-agent/missing-service-probe': {
      inject: ['sessions'],
      apply() {},
    },
  }
  await assert.rejects(
    () => bootPluginHost({ entries: [missingServiceRow], builtins, baseUrl: fixtureBaseUrl }),
    /missing-service.*sessions/,
  )
})
```

- [ ] **Step 2: Run the test and verify the host is missing**

Run: `node --import tsx --test tests/plugin-host.test.ts`

Expected: FAIL because `bootPluginHost` is not defined.

- [ ] **Step 3: Implement Loader boot**

Define the complete host interface before implementing it:

```ts
export type BuiltinPluginMap = Readonly<Record<string, unknown>>

export interface PluginHostOptions {
  entries: readonly EntryOptions[]
  baseUrl: string
  builtins: BuiltinPluginMap
}

export interface StartProfileOptions {
  home?: string
  installAnchor?: string
  builtins?: BuiltinPluginMap
}

export interface PluginHost {
  ctx: Context
  dispose(): Promise<void>
}
```

The core sequence is:

```ts
const ctx = new Context()
await ctx.plugin(Loader, { baseUrl: options.baseUrl })
Object.assign(ctx.loader.builtins, options.builtins)
for (const entry of options.entries) await ctx.loader.create(entry)
await ctx.loader.await()
```

After `await()`, inspect Loader entries and reject fibers that failed or remained pending on required injections. On any failure, dispose the root fiber before rethrowing.

`startAiAgentProfile()` calls `healProfilesModuleFallback()`, loads and composes the named profile, merges the standard built-in map with any test overrides, and delegates to `bootPluginHost()` with the profile `package.json` URL as `baseUrl`.

- [ ] **Step 4: Add idempotent shutdown**

```ts
let disposed = false
return {
  ctx,
  async dispose() {
    if (disposed) return
    disposed = true
    await ctx.fiber.dispose()
  },
}
```

Register `SIGINT` and `SIGTERM` only in `scripts/ai-agent.ts`, not inside the reusable host module.

- [ ] **Step 5: Connect CLI profile start and config dump**

`--dump-config` serializes `composeProfileEntries(profile)` and exits without booting plugins. Normal profile start passes the composed entries and built-in map into `bootPluginHost()`.

- [ ] **Step 6: Run the focused host tests**

Run: `node --import tsx --test tests/plugin-host.test.ts`

Expected: PASS, including disposer ordering and missing-service diagnostics.

- [ ] **Step 7: Commit Cordis boot**

```bash
git add src/plugins/host.ts scripts/ai-agent.ts tests/plugin-host.test.ts
git commit -m "feat: boot profiles through Cordis"
```

---

### Task 4: Move the Existing HTTP API Behind `ctx.webServer`

**Files:**
- Create: `src/server/http.ts`
- Create: `src/server/coreRoutes.ts`
- Create: `src/server/staticWeb.ts`
- Modify: `src/server/server.ts`
- Modify: `src/config/appConfig.ts`
- Modify: `src/plugins/host.ts`
- Create: `tests/webserver-plugin.test.ts`

**Interfaces:**
- Produces: `sendJson(res: ServerResponse, status: number, payload: unknown): void`
- Produces: `readJson(req: IncomingMessage, maxBytes?: number): Promise<Record<string, unknown>>`
- Produces: `coreRoutesPlugin.apply(ctx: Context): void`
- Produces: `staticWebPlugin.apply(ctx: Context, config: { root: string }): void`
- Consumes: DSH `ctx.webServer.register()` and `ctx.webServer.registerFallback()`

- [ ] **Step 1: Write route coexistence and disposal tests**

Create this local test helper so every test boots the same real Cordis WebServer on an OS-assigned port:

```ts
const pagecraftProbePlugin = {
  inject: ['webServer'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/api/frontend-feedback/probe',
      handler: (_req, res) => res.end('pagecraft'),
    }), 'pagecraft probe route')
  },
}

const probeRoutePlugin = {
  inject: ['webServer'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/probe',
      handler: (_req, res) => res.end('ok'),
    }), 'disposable probe route')
  },
}

async function bootTestWebHost(plugins: Array<{ id: string; name: string; plugin: unknown }>) {
  const builtins = Object.fromEntries(plugins.map(item => [item.name, item.plugin]))
  const entries: EntryOptions[] = [
    { id: 'web-server', name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
    ...plugins.map(item => ({ id: item.id, name: item.name })),
  ]
  const host = await bootPluginHost({ entries, builtins, baseUrl: fixtureBaseUrl })
  return {
    ...host,
    url: (path: string) => `http://127.0.0.1:${host.ctx.webServer.port}${path}`,
    remove: (id: string) => host.ctx.loader.remove(id),
  }
}
```

```ts
test('an exact PageCraft route wins before the built-in /api prefix', async () => {
  const host = await bootTestWebHost([
    { id: 'core-routes', name: '@ai-agent/core-routes', plugin: coreRoutesPlugin },
    { id: 'pagecraft-probe', name: '@test/pagecraft-probe', plugin: pagecraftProbePlugin },
  ])
  assert.equal(await (await fetch(host.url('/api/frontend-feedback/probe'))).text(), 'pagecraft')
  await host.dispose()
})

test('disposing a route fiber makes its endpoint unavailable', async () => {
  const host = await bootTestWebHost([{ id: 'probe-route', name: '@test/probe-route', plugin: probeRoutePlugin }])
  assert.equal((await fetch(host.url('/probe'))).status, 200)
  await host.remove('probe-route')
  assert.equal((await fetch(host.url('/probe'))).status, 404)
})
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --import tsx --test tests/webserver-plugin.test.ts`

Expected: FAIL because the route plugins do not exist.

- [ ] **Step 3: Extract HTTP helpers without changing response formats**

Move `sendJson`, `readJson`, `getSessionId`, and error-to-status logic from `server.ts` to `http.ts`. Add a request-byte ceiling to `readJson` and preserve the current JSON error payloads.

- [ ] **Step 4: Register the existing API as a prefix route**

Export the current request switch as `handleCoreRequest()`, then mount it through one reversible contribution:

```ts
export const coreRoutesPlugin = {
  name: 'ai-agent-core-routes',
  inject: ['webServer'],
  apply(ctx: Context) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api',
      handler: handleCoreRequest,
    }), 'ai-agent core API')
  },
}
```

The DSH WebServer exact-route lookup must run before prefix lookup, allowing PageCraft exact paths to override the generic `/api` fallback.

- [ ] **Step 5: Add the static fallback and reduce `server.ts` to bootstrap**

`staticWebPlugin` serves only files under `web/dist`, maps missing SPA paths to `index.html`, sets content types, and rejects resolved paths outside the root. In development, Vite remains the shell server.

`server.ts` becomes:

```ts
const profile = process.env.AI_AGENT_PROFILE ?? 'web'
const host = await startAiAgentProfile(profile)
console.log(`Agent web server listening on http://${host.ctx.webServer.host}:${host.ctx.webServer.port}`)
```

- [ ] **Step 6: Run route and regression checks**

Run: `node --import tsx --test tests/webserver-plugin.test.ts`

Expected: PASS.

Run: `npm test`

Expected: current non-preview API tests remain green.

- [ ] **Step 7: Commit the WebServer migration**

```bash
git add src/server/http.ts src/server/coreRoutes.ts src/server/staticWeb.ts src/server/server.ts src/config/appConfig.ts src/plugins/host.ts tests/webserver-plugin.test.ts
git commit -m "refactor: mount HTTP routes through Cordis"
```

---

### Task 5: Make Skills a Runtime Cordis Service

**Files:**
- Create: `src/plugins/services/skills.ts`
- Modify: `src/skills/registry.ts`
- Modify: `src/skills/index.ts`
- Modify: `src/server/coreRoutes.ts`
- Modify: `src/plugins/host.ts`
- Modify: `src/orchestrator/agent.ts`
- Create: `tests/plugin-skills.test.ts`
- Modify: `tests/skill-workflow.test.ts`

**Interfaces:**
- Produces: `managedSkillsPlugin`
- Produces: `ManagedSkillsService.list(): Promise<ManagedSkill[]>`
- Produces: `ManagedSkillsService.upload(params): Promise<ManagedSkill>`
- Produces: `ManagedSkillsService.setEnabled(id, enabled): Promise<ManagedSkill>`
- Produces: `ManagedSkillsService.delete(id): Promise<{ deleted: boolean }>`
- Produces: `AgentSkillSource.list(cwd: string): Promise<Skill[]>`
- Produces: `AgentSkillSource.get(name: string, cwd: string): Promise<string | null>`

Define the Agent-facing adapter independently from the full DSH registry:

```ts
export interface AgentSkillSource {
  list(cwd: string): Promise<Skill[]>
  get(name: string, cwd: string): Promise<string | null>
}
```

- [ ] **Step 1: Write plugin Skill lifecycle tests**

```ts
const pagecraftSkillProbe = {
  name: 'pagecraft-skill-probe',
  inject: ['skills'],
  apply(ctx: Context) {
    ctx.skills.register({
      name: 'frontend-page-builder',
      description: 'Build pages',
      source: 'bundled',
      resourceBase: { kind: 'opaque', description: 'test skill' },
      content: 'build pages',
    })
  },
}

async function bootSkillHost(plugin: unknown) {
  const host = await bootPluginHost({
    baseUrl: fixtureBaseUrl,
    entries: [
      { id: 'skills', name: '@deepseek-ai/dsh-skill' },
      { id: 'managed-skills', name: '@ai-agent/managed-skills' },
      { id: 'pagecraft-skill-probe', name: '@test/pagecraft-skill-probe' },
    ],
    builtins: {
      '@ai-agent/managed-skills': managedSkillsPlugin,
      '@test/pagecraft-skill-probe': plugin,
    },
  })
  return {
    ...host,
    agentSkills: createAgentSkillSource(host.ctx.skills),
    managedSkills: host.ctx.managedSkills,
    remove: (id: string) => host.ctx.loader.remove(id),
  }
}

test('a plugin skill enters the Agent catalog and disappears on fiber disposal', async () => {
  const host = await bootSkillHost(pagecraftSkillProbe)
  assert.match(await host.agentSkills.get('frontend-page-builder', workspace), /build pages/)
  await host.remove('pagecraft-skill-probe')
  assert.equal(await host.agentSkills.get('frontend-page-builder', workspace), null)
  await host.dispose()
})

test('uploaded skills remain managed while plugin skills are read-only', async () => {
  const host = await bootSkillHost(pagecraftSkillProbe)
  const listed = await host.managedSkills.list()
  assert.equal(listed.find(item => item.name === 'frontend-page-builder')?.source, 'plugin')
  await assert.rejects(() => host.managedSkills.delete('plugin:frontend-page-builder'), /cannot be deleted/i)
  await host.dispose()
})
```

- [ ] **Step 2: Run the tests and verify the service is missing**

Run: `node --import tsx --test tests/plugin-skills.test.ts`

Expected: FAIL because `managedSkillsPlugin` does not exist.

- [ ] **Step 3: Mount the official DSH SkillRegistry**

The built-in Skill plugin mounts `SkillRegistry` from `@deepseek-ai/dsh-skill` under service key `skills`, then mounts `ManagedSkillsService` under `managedSkills`. The managed service owns disposers for built-in and uploaded enabled skills:

```ts
const dispose = ctx.skills.register({
  name: skill.name,
  description: skill.description,
  source: skill.source === 'builtin' ? 'runtime' : 'custom',
  resourceBase: { kind: 'directory', path: dirname(skill.filePath) },
  content: skill.content,
})
```

Refresh removes the prior managed contributions before registering the new snapshot. External plugin contributions are owned by their own fibers and are never removed by this refresh.

- [ ] **Step 4: Refactor file persistence into a managed provider store**

Keep validation, hashed filenames, registry JSON, enable state, and deletion in `src/skills/registry.ts`, but export loaded file metadata so the Cordis bridge can register it. Extend `ManagedSkill.source` to:

```ts
type SkillSource = 'builtin' | 'custom' | 'plugin'
```

Plugin skills use stable ids `plugin:<provider>:<name>` and reject delete/enable mutations with status `403`.

- [ ] **Step 5: Route Agent Skill discovery through an injected source**

Replace direct `loadSkills(SKILLS_DIR)` in `Agent.run()` with:

```ts
const allSkills = await this.runtime.skills.list(effectiveAllowedPaths[0])
```

Replace `useSkill(allSkills, skillName)` with `await this.runtime.skills.get(skillName, effectiveAllowedPaths[0])`. Retain the current file loader as `legacyAgentRuntime.skills` for the command-line orchestrator until Task 7 injects the profile runtime.

- [ ] **Step 6: Run Skill and build checks**

Run: `node --import tsx --test tests/plugin-skills.test.ts tests/skill-workflow.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS with no duplicate `ctx.skills` service registration.

- [ ] **Step 7: Commit Skill integration**

```bash
git add src/plugins/services/skills.ts src/skills/registry.ts src/skills/index.ts src/server/coreRoutes.ts src/plugins/host.ts src/orchestrator/agent.ts tests/plugin-skills.test.ts tests/skill-workflow.test.ts
git commit -m "feat: expose skills through Cordis"
```

---

### Task 6: Make Tools Effect-Owned and Inject Them into the Agent

**Files:**
- Create: `src/plugins/services/tools.ts`
- Create: `src/orchestrator/runtime.ts`
- Modify: `src/tools/index.ts`
- Modify: `src/orchestrator/agent.ts`
- Modify: `src/orchestrator/orchestrator.ts`
- Modify: `src/plugins/host.ts`
- Create: `tests/plugin-tools.test.ts`
- Modify: `tests/fork-tool.test.ts`

**Interfaces:**
- Produces: `ToolRegistry.register(name: string, definition: ToolDef): () => void`
- Produces: `ToolRegistry.definitions(scope: ToolScope): ToolDefinition[]`
- Produces: `ToolRegistry.execute(request: ToolExecutionRequest): Promise<string>`
- Produces: `AgentRuntime = { skills: AgentSkillSource; tools: AgentToolSource }`
- Consumes: `Agent` and `Orchestrator` constructors accept `AgentRuntime`

Export the types that plugin and Agent code share:

```ts
export type ToolScope = 'read' | 'write' | 'memory'
export interface ToolExecutionRequest {
  name: string
  args: Record<string, string>
  allowedPaths: string[]
  designConfirmed?: boolean
  signal?: AbortSignal
  turnLoadedSkills?: Set<string>
  repository?: RepositoryConfig
}
export interface AgentToolSource {
  definitions(scope: ToolScope): ToolDefinition[]
  execute(request: ToolExecutionRequest): Promise<string>
}
```

- [ ] **Step 1: Write registration, disposal, and permission tests**

```ts
test('registered tools appear in a snapshot and disappear after disposal', () => {
  const dispose = registry.register('probe', readProbe)
  assert.ok(registry.definitions('read').some(tool => tool.function.name === 'probe'))
  dispose()
  assert.ok(!registry.definitions('read').some(tool => tool.function.name === 'probe'))
})

test('plugin write tools cannot bypass design confirmation', async () => {
  registry.register('pluginWrite', writeProbe)
  const result = await registry.execute({
    name: 'pluginWrite', args: {}, allowedPaths: [workspace], designConfirmed: false,
  })
  assert.match(result, /未确认方案/)
  assert.equal(writeCalls, 0)
})
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `node --import tsx --test tests/plugin-tools.test.ts`

Expected: FAIL because the registry is missing.

- [ ] **Step 3: Move the existing definitions into built-in registrations**

Export the existing `ToolDef` values from `src/tools/index.ts` as `BUILTIN_TOOLS`. The Cordis plugin registers them one at a time:

```ts
export const builtinToolsPlugin = {
  inject: ['tools'],
  apply(ctx: Context) {
    for (const [name, definition] of Object.entries(BUILTIN_TOOLS)) {
      ctx.tools.register(name, definition)
    }
  },
}
```

Keep repository defaults, absolute-path checks, allowed-path containment, required arguments, memory gating, and error formatting inside `ToolRegistry.execute()`.

- [ ] **Step 4: Add explicit Agent runtime injection**

Define:

```ts
export interface AgentRuntime {
  skills: AgentSkillSource
  tools: {
    definitions(scope: ToolScope): ToolDefinition[]
    execute(request: ToolExecutionRequest): Promise<string>
  }
}
```

`new Agent(runtime = legacyAgentRuntime)` stores the dependency. `new Orchestrator(sessionId, initialState, runtime = legacyAgentRuntime)` constructs its Agent with the same runtime. `Orchestrator.load(sessionId, runtime)` forwards it.

- [ ] **Step 5: Replace static Agent tool calls**

Use:

```ts
const tools = [...this.runtime.tools.definitions('write'), USE_SKILL_TOOL_DEF]
const result = await this.runtime.tools.execute({
  name: tc.name,
  args,
  allowedPaths: effectiveAllowedPaths,
  designConfirmed: state.designConfirmed,
  signal,
  turnLoadedSkills,
  repository: state.repository,
})
```

The virtual `use_skill` tool remains inside Agent orchestration because it changes turn-local state.

- [ ] **Step 6: Run Tool and Agent regression checks**

Run: `node --import tsx --test tests/plugin-tools.test.ts tests/fork-tool.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 7: Commit Tool integration**

```bash
git add src/plugins/services/tools.ts src/orchestrator/runtime.ts src/tools/index.ts src/orchestrator/agent.ts src/orchestrator/orchestrator.ts src/plugins/host.ts tests/plugin-tools.test.ts tests/fork-tool.test.ts
git commit -m "feat: register agent tools through Cordis"
```

---

### Task 7: Add the Node Session Facade and FIFO Prompt Admission

**Files:**
- Create: `src/plugins/services/sessions.ts`
- Create: `src/server/promptQueue.ts`
- Modify: `src/server/sessionApi.ts`
- Modify: `src/server/coreRoutes.ts`
- Modify: `src/plugins/host.ts`
- Create: `tests/plugin-sessions.test.ts`
- Create: `tests/prompt-queue.test.ts`

**Interfaces:**
- Produces: `AiAgentSessionStore.get(sessionId: string): DshSessionFacade | undefined`
- Produces: `AiAgentSessionStore.attach(sessionId: string, orchestrator: Orchestrator, createdAt: number): () => void`
- Produces: `DshSessionFacade.header: { id: string; createdAt: number; cwd?: string }`
- Produces: `SessionPromptQueue.enqueue(job: PromptJob): Promise<void>`
- Produces: `SessionPromptQueue.abort(sessionId: string): Promise<void>`
- Produces: `configureSessionRuntime(runtime: AgentRuntime, queue: SessionPromptQueue): () => void`

Define the Node compatibility face used by installed plugins:

```ts
export interface DshSessionFacade {
  readonly header: {
    readonly id: string
    readonly createdAt: number
    readonly cwd?: string
  }
}
```

- [ ] **Step 1: Write synchronous Session lookup tests**

```ts
test('ctx.sessions returns a stable live object with the authorized cwd', async () => {
  const orchestrator = createTestOrchestrator({
    sessionId: 'session-001',
    allowedPaths: [workspace],
  })
  const detach = store.attach('session-001', orchestrator, 1725235200000)
  const first = store.get('session-001')
  const second = store.get('session-001')
  assert.equal(first, second)
  assert.equal(first?.header.cwd, workspace)
  detach()
})

test('an unloaded session is absent and unsupported methods fail explicitly', () => {
  assert.equal(store.get('missing'), undefined)
  const detach = store.attach('session-001', createTestOrchestrator({ sessionId: 'session-001' }), 0)
  const session = store.get('session-001') as DshSessionFacade & { fork(): void }
  assert.throws(() => session.fork(), /UNSUPPORTED_SESSION_CAPABILITY.*fork/)
  detach()
})
```

`createTestOrchestrator()` is a test-local factory around the existing `Orchestrator` constructor with the normal fake `AgentRuntime`; it fills all persisted defaults and applies only the supplied state overrides.

- [ ] **Step 2: Write FIFO and abort tests**

```ts
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test('prompt jobs for one session execute in FIFO order while sessions remain independent', async () => {
  const order: string[] = []
  const gates = { a: deferred(), b: deferred(), c: deferred() }
  const queue = new SessionPromptQueue(async job => {
    order.push(`start:${job.prompt}`)
    await gates[job.prompt as keyof typeof gates].promise
    order.push(`end:${job.prompt}`)
  })
  const makeJob = (sessionId: string, prompt: string): PromptJob => ({
    sessionId,
    prompt,
    onEvent() {},
  })
  const a = queue.enqueue(makeJob('s1', 'a'))
  const b = queue.enqueue(makeJob('s1', 'b'))
  const c = queue.enqueue(makeJob('s2', 'c'))
  await setImmediatePromise()
  gates.c.resolve()
  await c
  gates.a.resolve()
  await a
  gates.b.resolve()
  await Promise.all([a, b, c])
  assert.deepEqual(order, ['start:a', 'start:c', 'end:c', 'end:a', 'start:b', 'end:b'])
})
```

Define `setImmediatePromise()` in the test as `new Promise<void>(resolve => setImmediate(resolve))`; this lets both independent session heads start before either gate is released.

- [ ] **Step 3: Run both tests and verify failure**

Run: `node --import tsx --test tests/plugin-sessions.test.ts tests/prompt-queue.test.ts`

Expected: FAIL because both services are missing.

- [ ] **Step 4: Implement live-session observation**

Add `peekOrchestrator(sessionId)` and lifecycle notifications to `sessionApi.ts`. `AiAgentSessionStore.attach()` caches one facade per live Orchestrator and returns an idempotent detach function; `configureSessionRuntime()` subscribes it to lifecycle notifications. Its `header.cwd` getter reads the current `allowedPaths[0]`, so changing the selected directory does not strand PageCraft on stale data.

Install the service as `sessions` before external plugins activate:

```ts
export interface AiAgentSessionStoreContract {
  get(id: string): DshSessionFacade | undefined
  attach(id: string, orchestrator: Orchestrator, createdAt: number): () => void
}
```

Implement `AiAgentSessionStore extends Service implements AiAgentSessionStoreContract`; its constructor calls `super(ctx, 'sessions')`, `get()` reads the private live-facade map, and `attach()` inserts the facade and returns the idempotent deletion closure.

Return each facade through a `Proxy`: declared properties such as `header` work normally, while accessing any undeclared capability throws an error whose `code` is `UNSUPPORTED_SESSION_CAPABILITY` and whose message includes the property name. This prevents partial DSH Session compatibility from failing as an opaque JavaScript `TypeError`.

- [ ] **Step 5: Implement FIFO execution and stream ownership**

Each queued job carries its own event sink:

```ts
export interface PromptJob {
  sessionId: string
  prompt: string
  onEvent(event: AgentEvent): void | Promise<void>
  signal?: AbortSignal
}
```

Only the queue calls `markSessionRunning`, `orchestrator.handleUserInput`, and `markSessionIdle`. It starts the next job in `finally`, even when the prior job fails or aborts. Deleting a session rejects its queued jobs before removing disk state.

- [ ] **Step 6: Route `/stream` through the queue**

Remove the current `409` branch. `handleStream()` validates the prompt, opens the JSON stream, enqueues the job, forwards events to that response, writes `done` only for that job, and closes its response when the queued execution settles. `abortSession()` aborts the active Orchestrator and does not discard later queued jobs.

Call `configureSessionRuntime()` from the profile host so newly loaded Orchestrators receive the Cordis-backed `AgentRuntime` from Tasks 5 and 6.

- [ ] **Step 7: Run Session, queue, and build checks**

Run: `node --import tsx --test tests/plugin-sessions.test.ts tests/prompt-queue.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 8: Commit Session compatibility**

```bash
git add src/plugins/services/sessions.ts src/server/promptQueue.ts src/server/sessionApi.ts src/server/coreRoutes.ts src/plugins/host.ts tests/plugin-sessions.test.ts tests/prompt-queue.test.ts
git commit -m "feat: add plugin session facade and prompt queue"
```

---

### Task 8: Discover and Serve Active `dsh.client` Bundles

**Files:**
- Create: `src/plugins/clientModules.ts`
- Modify: `src/plugins/types.ts`
- Modify: `src/plugins/host.ts`
- Create: `tests/client-modules-host.test.ts`
- Create: `tests/fixtures/plugins/client-probe/package.json`
- Create: `tests/fixtures/plugins/client-probe/lib/client.js`

**Interfaces:**
- Produces: `ClientModuleRegistry.refresh(entries: readonly ActiveLoaderEntry[]): void`
- Produces: `ClientModuleRegistry.manifest(): ClientManifest`
- Produces: `ClientModuleRegistry.resolveArtifact(pathname: string): ClientArtifact | undefined`
- Produces: `ClientModuleRegistry.serve(req: IncomingMessage, res: ServerResponse): Promise<void>`
- Produces: `ClientManifest = { revision: string; modules: ClientManifestRow[] }`
- Produces: `ClientManifestRow = { id: string; url: string; rev: string; inject?: string[]; immediately?: boolean }`

Use the Loader's public entry objects through this narrow read-only view:

```ts
export interface ActiveLoaderEntry {
  options: { name: string }
  disabled: boolean
  fiber?: unknown
}

export interface ClientArtifact {
  readonly pluginId: string
  readonly path: string
  readonly contentType: 'text/javascript' | 'application/json'
  readonly rev: string
}
```

`ClientModuleRegistry.refresh()` accepts `readonly ActiveLoaderEntry[]`; it does not retain or mutate Loader entries.

- [ ] **Step 1: Write manifest and path-safety tests**

```ts
const activeEntry = (name: string): ActiveLoaderEntry => ({
  options: { name },
  disabled: false,
  fiber: {},
})

test('active web client packages produce content-addressed manifest rows', () => {
  registry.refresh([activeEntry('client-probe')])
  const row = registry.manifest().modules[0]
  assert.equal(row.id, 'client-probe')
  assert.match(row.url, /^\/plugins\/client-probe\/client\.js\?rev=[a-f0-9]{12}$/)
})

test('artifact serving never resolves request text as a filesystem path', () => {
  registry.refresh([activeEntry('client-probe')])
  assert.equal(registry.resolveArtifact('/plugins/../package.json'), undefined)
  assert.equal(registry.resolveArtifact('/plugins/client-probe/client.js')?.path, fixtureClientPath)
})
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `node --import tsx --test tests/client-modules-host.test.ts`

Expected: FAIL because the registry does not exist.

- [ ] **Step 3: Implement package metadata resolution**

For every active, non-disabled Loader entry:

```ts
const pkg = readPackageJson(entry.options.name, profilePackageJson)
const client = parseDshClient(pkg.dsh?.client)
if (client?.platform !== 'web') return
const clientPath = resolvePackageExport(pkg, './client')
const rev = createHash('sha1').update(readFileSync(clientPath)).digest('hex').slice(0, 12)
```

Accept a string export or one-level `{ default: string }`. A package declaring `dsh.client` without a usable `./client` export fails activation.

- [ ] **Step 4: Register manifest and artifact routes**

Mount exact `/api/plugins/client-manifest` and prefix `/plugins` routes through `ctx.webServer`. The artifact handler looks up the decoded plugin id in the registry table, then serves its pre-resolved `clientPath` or `clientPath + '.map'`. It does not join arbitrary URL segments to a directory.

- [ ] **Step 5: Add revision consistency and disposal**

Build a manifest-level revision from the ordered row JSON. Refresh after Loader activation. Removing a plugin deletes its table row and changes the manifest revision. Artifact responses use immutable revision caching only when the query revision matches the active row.

- [ ] **Step 6: Run focused tests and build**

Run: `node --import tsx --test tests/client-modules-host.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 7: Commit Node client-module hosting**

```bash
git add src/plugins/clientModules.ts src/plugins/types.ts src/plugins/host.ts tests/client-modules-host.test.ts tests/fixtures/plugins/client-probe
git commit -m "feat: serve DSH client plugin bundles"
```

---

### Task 9: Build the Browser Module Kernel and Slot Service

**Files:**
- Modify: `web/package.json`
- Modify: `package-lock.json`
- Create: `web/src/plugins/types.ts`
- Create: `web/src/plugins/clientModuleSystem.ts`
- Create: `web/src/plugins/slots.ts`
- Create: `web/src/plugins/SlotOutlet.tsx`
- Create: `tests/client-module-system.test.ts`
- Create: `tests/browser-slots.test.tsx`

**Interfaces:**
- Produces: `ClientModuleSystem.import(id: string): Promise<Record<string, unknown>>`
- Produces: `ClientModuleSystem.prefetch(id: string): Promise<void>`
- Produces: `BrowserSlotService.declare(name: string, spec: SlotSpec): () => void`
- Produces: `BrowserSlotService.inject(name: string, install: () => Dispose): () => void`
- Produces: `BrowserSlotService.register(options: SlotRegistration, component: ComponentType): () => void`
- Produces: `<SlotOutlet name sessionId owner />`

Define the shared browser contracts in `web/src/plugins/types.ts`:

```ts
export interface TextContent { type: 'text'; text: string }
export type PromptResult = { ok: true } | { ok: false; error: { message: string } }
export interface SlotSpec { kind: 'single' | 'list'; scope: 'root' | 'session' }
export interface SlotRegistration {
  name: string
  id: string
  order?: number
  label?: () => string
  inject?: (sessionId: string) => Record<string, unknown>
}
export interface ClientManifestRow {
  id: string
  url: string
  rev: string
  inject?: string[]
  immediately?: boolean
}
export interface ClientManifest {
  revision: string
  modules: ClientManifestRow[]
}
```

- [ ] **Step 1: Add browser Cordis dependency**

Add `@deepseek-ai/cordis: 4.0.1` to `web/package.json` and regenerate the workspace lock with `npm install --package-lock-only`.

- [ ] **Step 2: Write module factory tests**

```ts
test('the DSH wrapper registers once and materializes with host React modules', async () => {
  const system = new ClientModuleSystem({
    modules: [{ id: 'probe', url: '/probe.js', rev: 'abc' }],
    seeds: { react: React, 'react/jsx-runtime': jsxRuntime, 'react-dom': ReactDOM },
    loadBundle: async () => window.__ModuleLoader__.load({
      id: 'probe',
      factory: require => ({ react: require('react') }),
    }),
  })
  assert.equal((await system.import('probe')).react, React)
  await assert.rejects(() => system.import('missing'), /cannot resolve "missing"/)
})
```

- [ ] **Step 3: Write delayed Slot injection and render tests**

```tsx
const PageCraftProbe = () => <button type="button">PageCraft</button>

test('slot injection waits for declaration, renders in order, and tears down', () => {
  const disposeInject = slots.inject('conversation.input.left', () =>
    slots.register({ name: 'conversation.input.left', id: 'pagecraft', order: 30 }, PageCraftProbe))
  assert.deepEqual(slots.entries('conversation.input.left'), [])
  const disposeDeclare = slots.declare('conversation.input.left', { kind: 'list', scope: 'session' })
  assert.equal(slots.entries('conversation.input.left')[0]?.id, 'pagecraft')
  const html = renderToStaticMarkup(
    <SlotOutlet runtime={{ slots }} name="conversation.input.left" sessionId="session-001" owner={{}} />,
  )
  assert.match(html, />PageCraft<\/button>/)
  disposeDeclare()
  assert.deepEqual(slots.entries('conversation.input.left'), [])
  disposeInject()
})
```

- [ ] **Step 4: Run both tests and verify failure**

Run: `node --import tsx --test tests/client-module-system.test.ts tests/browser-slots.test.tsx`

Expected: FAIL because the browser plugin modules are missing.

- [ ] **Step 5: Implement the DSH lazy CJS kernel**

Install `window.__ModuleLoader__` in the constructor. Keep separate graph rows, factories, materialized records, pending arrivals, and a materialization guard. Normalize `<id>/client` to `<id>`. `require()` resolves seed modules, then existing records, then already-arrived factories; it never performs asynchronous fetch.

Claim styles created during factory materialization by tagging unowned `<style>` elements with `data-plugin=<id>` so disposal can remove plugin-owned CSS.

- [ ] **Step 6: Implement the Slot service and React outlet**

The service extends Cordis `Service` under key `slots`. It tracks declarations and ordered entries. `inject()` installs immediately when a declaration exists, otherwise subscribes until it appears. Both the injection controller and active registration are effects belonging to the caller's fiber.

`SlotOutlet` uses `useSyncExternalStore`, evaluates the entry's `inject(sessionId)` face, and renders each component through an error boundary keyed by `entry.id`.

- [ ] **Step 7: Run browser kernel checks**

Run: `node --import tsx --test tests/client-module-system.test.ts tests/browser-slots.test.tsx`

Expected: PASS.

Run: `npm run build:web`

Expected: PASS.

- [ ] **Step 8: Commit browser kernel and slots**

```bash
git add web/package.json package-lock.json web/src/plugins/types.ts web/src/plugins/clientModuleSystem.ts web/src/plugins/slots.ts web/src/plugins/SlotOutlet.tsx tests/client-module-system.test.ts tests/browser-slots.test.tsx
git commit -m "feat: add browser plugin kernel and slots"
```

---

### Task 10: Bind Browser Plugins to the Existing React Session

**Files:**
- Create: `web/src/plugins/sessions.ts`
- Create: `web/src/plugins/runtime.ts`
- Modify: `web/src/main.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/api.ts`
- Modify: `web/src/styles.css`
- Modify: `web/vite.config.ts`
- Create: `tests/browser-plugin-runtime.test.tsx`

**Interfaces:**
- Produces: `bootBrowserPluginRuntime(): Promise<BrowserPluginRuntime>`
- Produces: `consumePromptStream(sessionId: string, text: string): Promise<void>` by extracting the current stream loop unchanged
- Produces: `BrowserSessionService.binding(id: string): { session: BrowserSessionFacade } | undefined`
- Produces: `BrowserSessionFacade.prompt(content: TextContent[], mode: 'queue'): Promise<PromptResult>`
- Produces: `BrowserSessionFacade.subscribe(listener: () => void): () => void`
- Produces: `BrowserSessionFacade.getSnapshot(): { running: boolean }`
- Produces: `BrowserSessionService.notifyRunningChanged(id: string): void`
- Consumes: App calls `runtime.sessions.bind(sessionId, binding)` and renders `SlotOutlet`

- [ ] **Step 1: Write PageCraft-facing Session tests**

```ts
test('browser session facade exposes DSH queue semantics and observable running state', async () => {
  let running = false
  const prompts: string[] = []
  const seen: boolean[] = []
  const dispose = sessions.bind('session-001', {
    getRunning: () => running,
    prompt: async text => { prompts.push(text); return { ok: true as const } },
  })
  const session = sessions.binding('session-001')?.session
  session?.subscribe(() => { seen.push(Boolean(session.getSnapshot().running)) })
  assert.deepEqual(await session?.prompt([{ type: 'text', text: '[frontend-feedback] {}' }], 'queue'), { ok: true })
  assert.deepEqual(prompts, ['[frontend-feedback] {}'])
  running = true
  sessions.notifyRunningChanged('session-001')
  assert.deepEqual(seen, [true])
  dispose()
  assert.equal(sessions.binding('session-001'), undefined)
})
```

- [ ] **Step 2: Write runtime activation test**

Mock the client manifest and bundle loader, activate a probe client plugin with `inject = ['slots', 'sessions']`, declare `conversation.input.left`, and assert that its launcher is rendered for `session-001`.

- [ ] **Step 3: Run tests and verify failure**

Run: `node --import tsx --test tests/browser-plugin-runtime.test.tsx`

Expected: FAIL because the runtime and session service are missing.

- [ ] **Step 4: Implement browser Session bindings**

PageCraft passes arrays of text blocks. Accept only non-empty `{ type: 'text', text: string }` values, join them with newlines, reject unknown content with:

```ts
{ ok: false, error: { message: 'AI Agent browser session supports text prompt content only' } }
```

The facade has stable object identity for one binding lifetime. `notifyRunningChanged(sessionId)` publishes only when the boolean snapshot changes.

- [ ] **Step 5: Boot plugins before React renders**

`bootBrowserPluginRuntime()` performs:

```ts
const platformSeeds = {
  react: React,
  'react-dom': ReactDOM,
  'react/jsx-runtime': jsxRuntime,
}
const fetchClientManifest = async (): Promise<ClientManifest> => {
  const response = await fetch('/api/plugins/client-manifest')
  if (!response.ok) throw new Error(`Plugin manifest request failed: ${response.status}`)
  return response.json() as Promise<ClientManifest>
}
const manifest = await fetchClientManifest()
const modules = new ClientModuleSystem({ modules: manifest.modules, seeds: platformSeeds })
const ctx = new Context()
await ctx.plugin(BrowserSlotService)
await ctx.plugin(BrowserSessionService)
for (const row of manifest.modules) {
  if (row.immediately) await modules.prefetch(row.id)
  const plugin = await modules.import(row.id)
  await ctx.plugin(plugin)
}
return { ctx, modules, slots: ctx.slots, sessions: ctx.sessions }
```

`main.tsx` renders an explicit startup error if this Promise rejects; it must not silently launch without configured plugins.

- [ ] **Step 6: Integrate App prompt handling and Slot rendering**

Refactor `sendPrompt` so both the composer and plugin Session facade call one function:

```ts
async function submitPrompt(text: string, source: 'composer' | 'plugin'): Promise<PromptResult> {
  if (!selectedSessionId) return { ok: false, error: { message: 'No active session' } }
  void source
  void consumePromptStream(selectedSessionId, text)
  return { ok: true }
}
```

Extract the current `/stream` fetch, event decoding, transcript updates, and terminal error handling from `sendPrompt` into `consumePromptStream()` without changing their behavior. Do not add a persisted transcript field solely for the `source` distinction.

The backend FIFO owns serialization, so plugin submission is allowed while `running` is true. Bind the selected Session through an effect and publish running changes. Render:

```tsx
<SlotOutlet
  runtime={pluginRuntime}
  name="conversation.input.left"
  sessionId={selectedSessionId}
  owner={{}}
/>
```

inside the existing input tool row.

- [ ] **Step 7: Proxy plugin artifacts during development**

Add `/plugins` beside `/api` in `vite.config.ts`:

```ts
proxy: {
  '/api': `http://localhost:${serverPort}`,
  '/plugins': `http://localhost:${serverPort}`,
}
```

- [ ] **Step 8: Run browser checks**

Run: `node --import tsx --test tests/browser-plugin-runtime.test.tsx`

Expected: PASS.

Run: `npm run build:web`

Expected: PASS.

- [ ] **Step 9: Commit browser Session integration**

```bash
git add web/src/plugins/sessions.ts web/src/plugins/runtime.ts web/src/main.tsx web/src/App.tsx web/src/api.ts web/src/styles.css web/vite.config.ts tests/browser-plugin-runtime.test.tsx
git commit -m "feat: connect client plugins to agent sessions"
```

---

### Task 11: Prove the Unchanged PageCraft Package Installs and Activates

**Files:**
- Create: `tests/pagecraft-plugin.integration.test.ts`
- Create: `tests/pagecraft-client.integration.test.tsx`
- Modify: `plugins/dsh-frontend-feedback/package.json` only if its existing package metadata fails the documented DSH contract; do not add AI Agent-specific metadata
- Modify: `package.json`

**Interfaces:**
- Consumes: profile manager, Cordis host, Skill service, Session facade, client-module registry, browser module kernel, Slot outlet
- Produces: `npm run test:pagecraft-plugin`

- [ ] **Step 1: Write a temporary-profile installation test**

Use a temporary `AI_AGENT_HOME` and the real package-manager runner to install the current PageCraft directory as a filesystem dependency without mutating the real profile or requiring network access:

```ts
async function installLocalPluginFixture(pluginDir: string): Promise<LoadedProfile> {
  const exitCode = runPluginCommand('test', ['add', `file:${pluginDir}`], {
    home: tempAgentHome,
    cwd: projectRoot,
    installAnchor,
  })
  assert.equal(exitCode, 0)
  return loadProfile('test', installAnchor, tempAgentHome)
}

test('the repository PageCraft package activates unchanged in an AI Agent profile', async () => {
  await installLocalPluginFixture(pagecraftDir)
  const host = await startAiAgentProfile('test', { home: tempAgentHome, installAnchor })
  const sessionId = await createSession()
  await updateAllowedPaths(sessionId, [workspace])
  await loadSession(sessionId)
  const baseUrl = `http://127.0.0.1:${host.ctx.webServer.port}`
  assert.ok(host.ctx.loader.entries().some(entry => entry.options.name === 'dsh-frontend-feedback'))
  assert.ok((await host.ctx.skills.list({ cwd: workspace })).some(skill => skill.name === 'frontend-page-builder'))
  assert.equal((await fetch(`${baseUrl}/api/frontend-feedback/workspace?sessionId=${sessionId}`)).status, 200)
  const clientModules = host.ctx.get('clientModules') as ClientModuleRegistry
  assert.ok(clientModules.manifest().modules.some(row => row.id === 'dsh-frontend-feedback'))
  await host.dispose()
})
```

- [ ] **Step 2: Write the real client-bundle activation test**

Read `plugins/dsh-frontend-feedback/lib/client.js`, execute it through the new `window.__ModuleLoader__`, activate its exported plugin in the browser Cordis context, declare `conversation.input.left`, and server-render the Slot outlet. Assert that the output contains `PageCraft` and `打开 PageCraft`.

- [ ] **Step 3: Run the integration tests and capture the first real incompatibility**

Run: `node --import tsx --test tests/pagecraft-plugin.integration.test.ts tests/pagecraft-client.integration.test.tsx`

Expected before final wiring: FAIL at the first missing service, bundle seed, or Slot prop. Fix the host adapter at the owning interface; do not branch on the PageCraft package name.

- [ ] **Step 4: Complete generic compatibility fixes**

For each failure, add a focused regression assertion to the relevant Task 3–10 test file, then update the generic service implementation. Acceptable fixes include DSH-compatible service method semantics, module seed aliases, manifest resolution, Slot injection props, or Session prompt results. A conditional such as `if (pluginId === 'dsh-frontend-feedback')` is not acceptable.

- [ ] **Step 5: Add the integration script**

```json
{
  "scripts": {
    "test:pagecraft-plugin": "node --import tsx --test tests/pagecraft-plugin.integration.test.ts tests/pagecraft-client.integration.test.tsx"
  }
}
```

- [ ] **Step 6: Run both package and host gates**

Run: `npm --prefix plugins/dsh-frontend-feedback run check`

Expected: PASS using the PageCraft package's current build and tests.

Run: `npm run test:pagecraft-plugin`

Expected: PASS without adding an AI Agent entry to PageCraft.

- [ ] **Step 7: Commit the compatibility gate**

```bash
git add package.json tests/pagecraft-plugin.integration.test.ts tests/pagecraft-client.integration.test.tsx
git commit -m "test: prove PageCraft plugin compatibility"
```

If a standards-only PageCraft package metadata correction was necessary, stage that exact file in the same commit and explain why DSH and AI Agent both require it.

---

### Task 12: Remove the Superseded Preview and Finish Product Documentation

**Files:**
- Delete: `src/server/preview.ts`
- Delete: `web/src/annotationPrompt.ts`
- Delete: `tests/preview-annotation.test.ts`
- Modify: `src/server/coreRoutes.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`
- Modify: `README.md`
- Modify: `plugins/dsh-frontend-feedback/README.md`
- Modify: `plugins/dsh-frontend-feedback/README.zh-CN.md`

**Interfaces:**
- Removes: legacy `/api/preview`
- Removes: legacy `agent-element-selected` annotation UI and `buildAnnotationPrompt`
- Preserves: chat, sessions, memory, metrics, repository configuration, Skill manager, confirmation UI, and abort controls
- Documents: CLI install, update, remove, list, profile boot, trust model, compatibility scope, and PageCraft usage

- [ ] **Step 1: Add a regression assertion that the legacy route is absent**

Extend the PageCraft integration test:

```ts
assert.equal((await fetch(`${baseUrl}/api/preview?url=http://localhost`)).status, 404)
assert.notEqual((await fetch(`${baseUrl}/api/frontend-feedback/preview?url=http://localhost`)).status, 404)
```

- [ ] **Step 2: Run the assertion and verify the old route still exists**

Run: `npm run test:pagecraft-plugin`

Expected: FAIL because `/api/preview` is still registered.

- [ ] **Step 3: Remove the legacy server implementation**

Delete `src/server/preview.ts`, remove its imports and `/api/preview` branch, and delete only the test coverage that belongs exclusively to the old implementation. Keep filesystem directory-picker tests by moving them to a new or existing file-browser test.

- [ ] **Step 4: Remove the legacy React preview and annotation state**

In `App.tsx`, remove `ViewMode`'s `preview` value, preview URL state, iframe ref, annotator `postMessage` listeners, selection/comment state, preview toolbar, and annotation composer. Keep chat and metrics views. Delete unused CSS selectors after `npm run build:web` identifies dead references.

- [ ] **Step 5: Update documentation without overwriting PageCraft iteration notes**

Document:

```powershell
npm install
npm run build
npm link
ai-agent plugin --profile web add github:noabt187/dsh-PageCraft
ai-agent --profile web
```

Explain that plugins are trusted local code, that restart is required after plugin-set changes, that compatibility targets DSH `0.1.0-rc.5`, and that plugins requiring services outside the supported catalog fail at activation. In both PageCraft READMEs, add only the AI Agent command alongside the existing DSH command; preserve current feature documentation.

- [ ] **Step 6: Run the complete verification matrix**

Run: `npm test`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

Run: `npm run build:web`

Expected: PASS.

Run: `npm run test:pagecraft-plugin`

Expected: PASS.

Run: `npm --prefix plugins/dsh-frontend-feedback run check`

Expected: PASS.

- [ ] **Step 7: Run the real local CLI smoke test**

Use a temporary home so no personal profile is changed:

```powershell
$env:AI_AGENT_HOME = Join-Path $env:TEMP 'ai-agent-pagecraft-smoke'
ai-agent plugin --profile web add D:\project\AI_Agent\plugins\dsh-frontend-feedback
ai-agent plugin --profile web list
ai-agent --profile web --dump-config
```

Expected: the list and dump show `dsh-frontend-feedback`, its bundle patch, and its web client bundle. Remove the temporary directory after verifying its resolved absolute path is under `$env:TEMP`.

- [ ] **Step 8: Commit cleanup and documentation**

```bash
git add README.md src/server/coreRoutes.ts web/src/App.tsx web/src/styles.css
git add -p plugins/dsh-frontend-feedback/README.md plugins/dsh-frontend-feedback/README.zh-CN.md
git add -u src/server/preview.ts web/src/annotationPrompt.ts tests/preview-annotation.test.ts
git commit -m "feat: replace built-in preview with PageCraft plugin"
```

For the interactive `git add -p`, stage only the newly appended AI Agent CLI documentation hunks. Leave every pre-existing PageCraft README hunk unstaged; if Git combines them into one hunk, split it with `s` before selecting.

- [ ] **Step 9: Verify final repository state**

Run: `git status --short`

Expected: only the user's pre-existing PageCraft working-tree changes and unrelated local artifacts remain; implementation files are committed. Confirm `git log --oneline -12` shows one focused commit per task and no commit includes `.tmp/`, `eval/`, the PageCraft zip, or unrelated working-tree files.

---

## Final Acceptance Walkthrough

1. Build PageCraft with `npm --prefix plugins/dsh-frontend-feedback run check`.
2. Install that exact directory into a temporary AI Agent `web` profile.
3. Start AI Agent from the profile and open the Web application.
4. Confirm the PageCraft launcher is rendered in `conversation.input.left`.
5. Select an AI Agent session whose primary allowed path is the test workspace.
6. Open PageCraft and verify workspace browsing resolves that exact directory.
7. Submit a `[frontend-feedback]` annotation and confirm it appears as a normal user message in the correct session.
8. While one turn runs, submit a second PageCraft request and confirm FIFO execution.
9. Verify direct text editing, DOM annotation, area annotation, and one presentation workflow against the unchanged package.
10. Remove PageCraft from the profile, restart, and confirm its routes, skills, client manifest row, and launcher are all absent.
11. Run the complete verification matrix from Task 12.
