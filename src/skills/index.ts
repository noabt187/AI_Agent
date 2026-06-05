import { readdir, readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'

export type Skill = {
  name: string
  description: string
  content: string
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
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
  const skills: Skill[] = []
  let entries: string[]
  try {
    entries = await readdir(skillsDir)
  } catch {
    return skills
  }

  for (const entry of entries) {
    if (extname(entry) !== '.md') continue
    const filePath = resolve(skillsDir, entry)
    try {
      const raw = await readFile(filePath, 'utf8')
      const { meta, body } = parseFrontmatter(raw)
      if (meta.name && meta.description && body) {
        skills.push({
          name: meta.name,
          description: meta.description,
          content: body,
        })
      }
    } catch {
      continue
    }
  }

  return skills
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
