import { loadEnabledSkills } from './registry.js'

export type Skill = {
  name: string
  description: string
  content: string
}

export interface AgentSkillSource {
  list(cwd: string): Promise<Skill[]>
  get(name: string, cwd: string): Promise<string | null>
}

export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('---')) return { meta: {}, body: trimmed }

  const endIdx = trimmed.indexOf('---', 3)
  if (endIdx === -1) return { meta: {}, body: trimmed }

  const frontmatter = trimmed.slice(3, endIdx).trim()
  const body = trimmed.slice(endIdx + 3).trim()

  const meta: Record<string, string> = {}
  for (const line of frontmatter.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key && value) meta[key] = value
  }

  return { meta, body }
}

export async function loadSkills(skillsDir: string): Promise<Skill[]> {
  return loadEnabledSkills(skillsDir)
}

export function createFileAgentSkillSource(skillsDir: string): AgentSkillSource {
  return {
    list: async () => loadSkills(skillsDir),
    async get(name) {
      return useSkill(await loadSkills(skillsDir), name)
    },
  }
}

export function useSkill(skills: Skill[], skillName: string): string | null {
  const skill = skills.find((s) => s.name === skillName)
  return skill ? skill.content : null
}

export function getSkillCatalog(skills: Skill[]): string {
  if (skills.length === 0) return ''
  return skills
    .map((s) => `- ${s.name}: ${s.description}`)
    .join('\n')
}
