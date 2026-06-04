import { readdir, readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import type { WorldState } from '../orchestrator/types.js'

export type Skill = {
  name: string
  trigger: string
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

  for (const entry of entries.sort()) {
    if (extname(entry) !== '.md') continue
    const filePath = resolve(skillsDir, entry)
    try {
      const raw = await readFile(filePath, 'utf8')
      const { meta, body } = parseFrontmatter(raw)
      if (meta.name && meta.trigger && body) {
        skills.push({
          name: meta.name,
          trigger: meta.trigger,
          description: meta.description ?? '',
          content: body,
        })
      }
    } catch {
      continue
    }
  }

  return skills
}

function matchesRepositoryRequest(input: string): boolean {
  return /fork|clone|克隆|远程仓库|repository|创建\s*fork|新建\s*fork/i.test(input)
}

function matchesPullRequest(input: string): boolean {
  return /\bpr\b|pull request|提\s*pr|提交\s*pr|创建\s*pr|发起\s*pr/i.test(input)
}

function matchesOperationalRequest(input: string): boolean {
  return matchesPullRequest(input) || matchesRepositoryRequest(input)
}

function matchesTrigger(trigger: string, state: WorldState, userInput = ''): boolean {
  switch (trigger) {
    case 'always':
      return true
    case 'has_goal_no_requirement':
      return !!state.goal && !state.confirmedRequirement && !matchesOperationalRequest(`${state.goal}\n${userInput}`)
    case 'has_requirement_no_tasks':
      return !!state.confirmedRequirement && !state.designConfirmed && !state.designTasks?.length
    case 'has_tasks':
      return !!state.designConfirmed || !!state.designTasks?.length
    case 'repository_request':
      return matchesRepositoryRequest(`${state.goal ?? ''}\n${userInput}`)
    case 'pull_request_request':
      return matchesPullRequest(`${state.goal ?? ''}\n${userInput}`)
    default:
      return true
  }
}

export function getActiveSkills(skills: Skill[], state: WorldState, userInput = ''): Skill[] {
  return skills.filter((s) => matchesTrigger(s.trigger, state, userInput))
}

export function formatSkillContext(skills: Skill[]): string {
  if (skills.length === 0) return ''
  return skills
    .map((skill) => `### ${skill.name}\n${skill.content}`)
    .join('\n\n')
}
