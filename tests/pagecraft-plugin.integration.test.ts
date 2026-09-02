import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { afterEach } from 'node:test'
import type { Orchestrator } from '../src/orchestrator/orchestrator.js'
import { INSTALL_ANCHOR, startAiAgentProfile } from '../src/plugins/host.js'
import { runPluginCommand } from '../src/plugins/manager.js'
import { initProfile, resolveProfileDir } from '../src/plugins/profile.js'
import type { ClientModuleRegistry } from '../src/plugins/clientModules.js'

const projectRoot = resolve(import.meta.dirname, '..')
const pagecraftDir = join(projectRoot, 'plugins', 'dsh-frontend-feedback')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test('the repository PageCraft package installs and activates unchanged in an AI Agent profile', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'ai-agent-pagecraft-home-'))
  const workspace = await mkdtemp(join(tmpdir(), 'ai-agent-pagecraft-workspace-'))
  roots.push(home, workspace)
  writeFileSync(join(workspace, 'index.html'), '<main>PageCraft workspace</main>')
  const profileName = 'integration'
  initProfile(resolveProfileDir(profileName, home), ['@ai-agent/base', '@ai-agent/web-app'])
  const exitCode = runPluginCommand(profileName, [
    'add',
    `link:${pagecraftDir}`,
    '--offline',
    '--ignore-scripts',
  ], {
    home,
    cwd: projectRoot,
    installAnchor: INSTALL_ANCHOR,
  })
  assert.equal(exitCode, 0)

  const host = await startAiAgentProfile(profileName, { home, installAnchor: INSTALL_ANCHOR })
  t.after(() => host.dispose())
  const fakeOrchestrator = { state: { allowedPaths: [workspace] } } as unknown as Orchestrator
  const detachSession = host.ctx.sessions.attach('session-001', fakeOrchestrator, Date.now())
  t.after(detachSession)

  assert.ok([...host.ctx.loader.entries()].some(entry => entry.options.name === 'dsh-frontend-feedback'))
  const skills = await host.ctx.skills.list({ cwd: workspace })
  assert.ok(skills.some(skill => skill.name === 'frontend-page-builder'))
  assert.ok(skills.some(skill => skill.name === 'presentation-builder'))

  const baseUrl = `http://127.0.0.1:${host.ctx.webServer.port}`
  const workspaceResponse = await fetch(`${baseUrl}/api/frontend-feedback/workspace?sessionId=session-001`)
  assert.equal(workspaceResponse.status, 200)
  const workspacePayload = await workspaceResponse.json() as { rootPath?: string }
  assert.equal(workspacePayload.rootPath, workspace)

  const clientModules = host.ctx.get('clientModules') as ClientModuleRegistry
  assert.ok(clientModules.manifest().modules.some(row => row.id === 'dsh-frontend-feedback'))
})
