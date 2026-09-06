import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { bootPluginHost } from '../src/plugins/host.js'
import {
  createAgentSkillSource,
  managedSkillsPlugin,
} from '../src/plugins/services/skills.js'

const fixtureBaseUrl = pathToFileURL(`${import.meta.dirname}/`).href
const workspace = process.cwd()

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

async function bootSkillHost() {
  const host = await bootPluginHost({
    baseUrl: fixtureBaseUrl,
    entries: [
      { id: 'skills', name: '@deepseek-ai/dsh-skill' },
      { id: 'managed-skills', name: 'cordis:managed-skills' },
      { id: 'pagecraft-skill-probe', name: 'cordis:pagecraft-skill-probe' },
    ],
    builtins: {
      'managed-skills': managedSkillsPlugin,
      'pagecraft-skill-probe': pagecraftSkillProbe,
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
  const host = await bootSkillHost()
  assert.match(await host.agentSkills.get('frontend-page-builder', workspace) ?? '', /build pages/)
  await host.remove('pagecraft-skill-probe')
  assert.equal(await host.agentSkills.get('frontend-page-builder', workspace), null)
  await host.dispose()
})

test('managed listing includes read-only plugin skills', async () => {
  const host = await bootSkillHost()
  const listed = await host.managedSkills.list()
  const pagecraft = listed.find(item => item.name === 'frontend-page-builder')
  assert.equal(pagecraft?.source, 'plugin')
  assert.equal(pagecraft?.enabled, true)
  await assert.rejects(
    () => host.managedSkills.delete(pagecraft?.id ?? ''),
    error => error instanceof Error && /只读/.test(error.message) && 'statusCode' in error && error.statusCode === 403,
  )
  await host.dispose()
})

test('built-in managed skills are visible through the same Agent source', async () => {
  const host = await bootSkillHost()
  const skills = await host.agentSkills.list(workspace)
  assert.ok(skills.some(skill => skill.name === 'requirement-analysis'))
  await host.dispose()
})
