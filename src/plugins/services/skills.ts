import { dirname } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SkillRegistry, SkillSummary } from '@deepseek-ai/dsh-skill'
import {
  deleteManagedSkill,
  listManagedSkills,
  loadManagedSkillRecords,
  setManagedSkillEnabled,
  SkillRegistryError,
  uploadManagedSkill,
  type ManagedSkill,
} from '../../skills/registry.js'
import type { AgentSkillSource, Skill } from '../../skills/index.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    managedSkills: ManagedSkillsService
    skills: SkillRegistry
  }
}

type SkillUpload = { fileName: string; content: string }

export class ManagedSkillsService extends Service {
  static inject = ['skills']
  private registrations: Array<() => void> = []

  constructor(ctx: Context) {
    super(ctx, 'managedSkills')
  }

  async [Service.init](): Promise<void> {
    await this.refresh()
  }

  async list(): Promise<ManagedSkill[]> {
    const managed = await listManagedSkills()
    const pluginSkills = (await this.ctx.skills.list()).filter(skill => !isManagedProvider(skill.provider))
    const pluginRows = pluginSkills.map(pluginManagedSkill)
    return [...managed, ...pluginRows].sort(compareManagedSkills)
  }

  async upload(params: SkillUpload): Promise<ManagedSkill> {
    const created = await uploadManagedSkill(params)
    await this.refresh()
    return created
  }

  async setEnabled(id: string, enabled: boolean): Promise<ManagedSkill> {
    rejectPluginMutation(id)
    const updated = await setManagedSkillEnabled(id, enabled)
    await this.refresh()
    return updated
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    rejectPluginMutation(id)
    const result = await deleteManagedSkill(id)
    await this.refresh()
    return result
  }

  private async refresh(): Promise<void> {
    for (const dispose of this.registrations.splice(0).reverse()) dispose()
    const { skills, registry } = await loadManagedSkillRecords()
    for (const skill of skills) {
      if (!(registry.enabled[skill.id] ?? true)) continue
      const dispose = this.ctx.skills.register({
        name: skill.name,
        description: skill.description,
        source: skill.source === 'builtin' ? 'runtime' : 'custom',
        provider: `ai-agent-managed:${skill.id}`,
        resourceBase: { kind: 'directory', path: dirname(skill.filePath) },
        content: skill.content,
      })
      this.registrations.push(dispose)
    }
  }
}

export const managedSkillsPlugin = ManagedSkillsService

export function createAgentSkillSource(registry: SkillRegistry): AgentSkillSource {
  return {
    async list(cwd: string): Promise<Skill[]> {
      const summaries = await registry.list({ cwd })
      const loaded = await Promise.all(summaries.map(skill => registry.get(skill.name, { cwd })))
      return loaded
        .filter((skill): skill is NonNullable<typeof skill> => skill !== undefined && skill.invocation.modelInvocable)
        .map(skill => ({ name: skill.name, description: skill.description, content: skill.content }))
    },
    async get(name: string, cwd: string): Promise<string | null> {
      const skill = await registry.get(name, { cwd })
      if (!skill?.invocation.modelInvocable) return null
      return skill.content
    },
  }
}

function pluginManagedSkill(skill: SkillSummary): ManagedSkill {
  return {
    id: `plugin:${skill.provider}:${skill.name}`,
    name: skill.name,
    description: skill.description,
    summary: skill.description,
    enabled: true,
    source: 'plugin',
  }
}

function rejectPluginMutation(id: string): void {
  if (id.startsWith('plugin:')) {
    throw new SkillRegistryError('插件提供的 Skill 是只读的，请通过插件配置管理', 403)
  }
}

function isManagedProvider(provider: string): boolean {
  return provider.startsWith('ai-agent-managed:')
}

function compareManagedSkills(left: ManagedSkill, right: ManagedSkill): number {
  return Number(right.enabled) - Number(left.enabled)
    || Number(left.source === 'builtin') - Number(right.source === 'builtin')
    || left.name.localeCompare(right.name)
}

export type { AgentSkillSource }

export default ManagedSkillsService
