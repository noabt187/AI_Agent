import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import type { Skill } from './index.js'
import { parseFrontmatter } from './index.js'

type SkillSource = 'builtin' | 'custom'

export type ManagedSkill = {
  id: string
  name: string
  description: string
  trigger?: string
  summary?: string
  node?: string
  entry?: string
  enabled: boolean
  source: SkillSource
}

type LoadedSkill = Skill & {
  id: string
  filePath: string
  source: SkillSource
  trigger?: string
  summary?: string
  node?: string
  entry?: string
}

type StoredRegistry = {
  enabled: Record<string, boolean>
}

export class SkillRegistryError extends Error {
  statusCode: number

  constructor(message: string, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

const BUILTIN_SKILLS_DIR = resolve(import.meta.dirname ?? process.cwd())
const CUSTOM_SKILLS_DIR = resolve(process.cwd(), 'state', 'custom-skills')
const REGISTRY_PATH = resolve(process.cwd(), 'state', 'skills', 'registry.json')

function skillId(source: SkillSource, name: string): string {
  return `${source}:${name}`
}

function asSkill(raw: string, filePath: string, source: SkillSource): LoadedSkill | null {
  const { meta, body } = parseFrontmatter(raw)
  if (!meta.name || !meta.description || !body) return null

  return {
    id: skillId(source, meta.name),
    name: meta.name,
    description: meta.description,
    trigger: meta.trigger,
    summary: meta.summary || meta.description,
    node: meta.node,
    entry: meta.entry,
    content: body,
    filePath,
    source,
  }
}

function managedSkill(skill: LoadedSkill, enabled: boolean): ManagedSkill {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    trigger: skill.trigger,
    summary: skill.summary,
    node: skill.node,
    entry: skill.entry,
    enabled,
    source: skill.source,
  }
}

async function readRegistry(): Promise<StoredRegistry> {
  try {
    const parsed = JSON.parse(await readFile(REGISTRY_PATH, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { enabled: {} }
    const enabled = (parsed as { enabled?: unknown }).enabled
    if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled)) return { enabled: {} }
    return {
      enabled: Object.fromEntries(
        Object.entries(enabled).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
      ),
    }
  } catch {
    return { enabled: {} }
  }
}

async function saveRegistry(registry: StoredRegistry): Promise<void> {
  await mkdir(dirname(REGISTRY_PATH), { recursive: true })
  await writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf8')
}

async function loadSkillDir(dir: string, source: SkillSource): Promise<LoadedSkill[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const skills: LoadedSkill[] = []
  for (const entry of entries) {
    if (extname(entry).toLowerCase() !== '.md') continue
    const filePath = resolve(dir, entry)
    try {
      const skill = asSkill(await readFile(filePath, 'utf8'), filePath, source)
      if (skill) skills.push(skill)
    } catch {
      continue
    }
  }
  return skills
}

function dedupeByName(skills: LoadedSkill[]): LoadedSkill[] {
  const names = new Set<string>()
  const result: LoadedSkill[] = []
  for (const skill of skills) {
    const key = skill.name.toLowerCase()
    if (names.has(key)) continue
    names.add(key)
    result.push(skill)
  }
  return result
}

async function loadAllSkills(builtinSkillsDir = BUILTIN_SKILLS_DIR): Promise<{ skills: LoadedSkill[]; registry: StoredRegistry }> {
  const [builtinSkills, customSkills, registry] = await Promise.all([
    loadSkillDir(builtinSkillsDir, 'builtin'),
    loadSkillDir(CUSTOM_SKILLS_DIR, 'custom'),
    readRegistry(),
  ])

  return {
    skills: dedupeByName([...builtinSkills, ...customSkills]),
    registry,
  }
}

function isEnabled(skill: LoadedSkill, registry: StoredRegistry): boolean {
  return registry.enabled[skill.id] ?? true
}

function sortManaged(a: ManagedSkill, b: ManagedSkill): number {
  return Number(b.enabled) - Number(a.enabled)
    || Number(a.source === 'builtin') - Number(b.source === 'builtin')
    || a.name.localeCompare(b.name)
}

export async function listManagedSkills(): Promise<ManagedSkill[]> {
  const { skills, registry } = await loadAllSkills()
  return skills.map((skill) => managedSkill(skill, isEnabled(skill, registry))).sort(sortManaged)
}

export async function loadEnabledSkills(builtinSkillsDir: string): Promise<Skill[]> {
  const { skills, registry } = await loadAllSkills(builtinSkillsDir)
  return skills
    .filter((skill) => isEnabled(skill, registry))
    .map(({ id: _id, filePath: _filePath, source: _source, ...skill }) => skill)
}

function validateUploadedSkill(fileName: string, content: string): LoadedSkill {
  if (extname(fileName).toLowerCase() !== '.md') {
    throw new SkillRegistryError('Skill 文件必须是 .md')
  }

  const skill = asSkill(content, '', 'custom')
  if (!skill) {
    throw new SkillRegistryError('Skill frontmatter 必须包含 name 和 description，正文不能为空')
  }

  return skill
}

function customFileName(name: string, content: string): string {
  const safeName = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72)
  const hash = createHash('sha256').update(`${name}\n${content}`).digest('hex').slice(0, 8)
  return `${safeName || 'skill'}-${hash}.md`
}

export async function uploadManagedSkill(params: {
  fileName: string
  content: string
}): Promise<ManagedSkill> {
  const skill = validateUploadedSkill(params.fileName, params.content)
  const existing = await listManagedSkills()
  if (existing.some((item) => item.name.toLowerCase() === skill.name.toLowerCase())) {
    throw new SkillRegistryError(`Skill name 已存在：${skill.name}`, 409)
  }

  await mkdir(CUSTOM_SKILLS_DIR, { recursive: true })
  const fileName = customFileName(skill.name, params.content)
  const filePath = resolve(CUSTOM_SKILLS_DIR, fileName)
  await writeFile(filePath, params.content.trimEnd() + '\n', 'utf8')

  const registry = await readRegistry()
  registry.enabled[skillId('custom', skill.name)] = true
  await saveRegistry(registry)

  return managedSkill({ ...skill, filePath }, true)
}

export async function setManagedSkillEnabled(id: string, enabled: boolean): Promise<ManagedSkill> {
  const { skills, registry } = await loadAllSkills()
  const skill = skills.find((item) => item.id === id)
  if (!skill) throw new SkillRegistryError('Skill 不存在', 404)

  registry.enabled[id] = enabled
  await saveRegistry(registry)
  return managedSkill(skill, enabled)
}

export async function deleteManagedSkill(id: string): Promise<{ deleted: boolean }> {
  const { skills, registry } = await loadAllSkills()
  const skill = skills.find((item) => item.id === id)
  if (!skill) throw new SkillRegistryError('Skill 不存在', 404)
  if (skill.source !== 'custom') throw new SkillRegistryError('内置 Skill 不能删除', 403)

  await rm(skill.filePath, { force: true })
  delete registry.enabled[id]
  await saveRegistry(registry)
  return { deleted: true }
}
