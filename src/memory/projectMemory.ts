import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { WorldState } from '../orchestrator/types.js'

const execFileAsync = promisify(execFile)
const MEMORY_SCHEMA_VERSION = 1
const MIN_SEARCH_SCORE = 4
const MAX_PINNED = 20
const MAX_PINNED_CONTENT = 1000

const GENERIC_TERMS = new Set([
  '前端', '后端', '代码', '修改', '功能', '需求', '任务', '用户', '页面', '组件',
  '错误', '报错', '验证', '测试', '运行', '项目', '文件', '实现', '修复',
  'frontend', 'backend', 'src', 'test', 'tests', 'npm',
])

const CONTROL_PLANE_PATTERNS = [
  /不要跳过.*确认/,
  /\bdo not bypass\b.*\bconfirm|\bbypass\b.*\bconfirmation flow/i,
  /确认流程|confirmType|action\s*=\s*confirm/i,
  /WorldState|pendingConfirm|designConfirmed|allowedPaths/i,
  /写操作确认|工具白名单|命令白名单|可操作目录/,
  /本次.*不.*PR|不要提交|不要创建\s*PR|当前测试|临时测试/i,
]

export type ProjectMemory = {
  schemaVersion?: number
  id: string
  createdAt: number
  project: { key: string; rootDir: string; remoteUrl?: string }
  source: { sessionId: string; hash: string }
  requirement: { summary: string; keywords: string[]; targetModules: string[] }
  plan: { summary: string; tasks: string[]; decisions: string[] }
  implementation: { changedFiles: string[]; patterns: string[]; components: string[] }
  verification: { summary: string; commands: string[]; failures: string[] }
  reuseHints: string[]
  constraints: string[]
}

export type PinnedProjectMemory = {
  id: string
  createdAt: number
  content: string
  keywords: string[]
  sourceSessionId: string
}

type ProjectInfo = { key: string; rootDir: string; remoteUrl?: string }

function sha(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

async function git(projectDir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', projectDir, ...args])
    return String(stdout).trim() || null
  } catch {
    return null
  }
}

export async function resolveProjectInfo(projectDir: string): Promise<ProjectInfo> {
  const rootDir = await git(projectDir, ['rev-parse', '--show-toplevel']) ?? resolve(projectDir)
  const remoteUrl = await git(rootDir, ['remote', 'get-url', 'origin']) ?? undefined
  const keyHash = sha(`${remoteUrl ?? 'no-remote'}|${rootDir}`).slice(0, 16)
  const name = basename(rootDir).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48) || 'project'
  return { key: `${name}-${keyHash}`, rootDir, remoteUrl }
}

function memoryDir(projectKey: string): string {
  return resolve(process.cwd(), 'state', 'project-memory', projectKey)
}

function memoryPath(projectKey: string): string {
  return resolve(memoryDir(projectKey), 'memories.jsonl')
}

function pinnedPath(projectKey: string): string {
  return resolve(memoryDir(projectKey), 'pinned.json')
}

function unique(values: string[], limit = 20): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean))).slice(0, limit)
}

function asStringArray(value: unknown, limit = 20): string[] {
  return Array.isArray(value) ? unique(value.filter((v): v is string => typeof v === 'string'), limit) : []
}

function sanitizeText(value: string, limit = 1200): string {
  return value
    .split('\n')
    .filter((line) => !CONTROL_PLANE_PATTERNS.some((pattern) => pattern.test(line)))
    .join('\n')
    .trim()
    .slice(0, limit)
}

function sanitizeConstraints(values: string[]): string[] {
  return unique(values.filter((value) => !CONTROL_PLANE_PATTERNS.some((pattern) => pattern.test(value))), 12)
}

export function extractMemoryTerms(text: string): string[] {
  const terms = new Set<string>()
  const normalized = text.toLowerCase()
  for (const term of normalized.match(/[a-z0-9_./-]{2,}/g) ?? []) terms.add(term)
  for (const match of normalized.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const block = match[0]
    if (block.length <= 12) terms.add(block)
    for (let i = 0; i < block.length - 2; i++) terms.add(block.slice(i, i + 3))
  }
  return Array.from(terms).filter((term) => term.length >= 2 && !GENERIC_TERMS.has(term))
}

function normalizeMemory(memory: ProjectMemory): ProjectMemory {
  return {
    ...memory,
    schemaVersion: memory.schemaVersion ?? MEMORY_SCHEMA_VERSION,
    requirement: {
      summary: sanitizeText(memory.requirement.summary),
      keywords: unique(memory.requirement.keywords, 12),
      targetModules: unique(memory.requirement.targetModules, 12),
    },
    plan: {
      summary: sanitizeText(memory.plan.summary),
      tasks: unique(memory.plan.tasks, 20),
      decisions: unique(memory.plan.decisions, 20),
    },
    implementation: {
      changedFiles: unique(memory.implementation.changedFiles, 30),
      patterns: unique(memory.implementation.patterns, 20),
      components: unique(memory.implementation.components, 20),
    },
    verification: {
      summary: sanitizeText(memory.verification.summary, 1000),
      commands: unique(memory.verification.commands, 20),
      failures: unique(memory.verification.failures, 20),
    },
    reuseHints: unique(memory.reuseHints, 12),
    constraints: sanitizeConstraints(memory.constraints),
  }
}

function buildProjectMemory(project: ProjectInfo, sessionId: string, state: WorldState, doneMessage: string): ProjectMemory {
  const requirementSummary = state.confirmedRequirement || state.goal || doneMessage
  const tasks = state.designTasks?.map((t) => `${t.id} ${t.title}: ${t.description}`) ?? []
  const changedFiles = unique(state.designTasks?.map((t) => t.file) ?? [], 30)
  const targetModules = unique(changedFiles.map((file) => file.split('/').slice(0, -1).join('/')).filter(Boolean), 12)
  const sourceHash = sha(`${sessionId}|${state.goal ?? ''}|${state.confirmedRequirement ?? ''}|${doneMessage}`).slice(0, 16)

  return normalizeMemory({
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id: `${Date.now()}-${sourceHash}`,
    createdAt: Date.now(),
    project,
    source: { sessionId, hash: sourceHash },
    requirement: {
      summary: requirementSummary,
      keywords: extractMemoryTerms(requirementSummary).slice(0, 12),
      targetModules,
    },
    plan: {
      summary: tasks.length ? tasks.join('\n') : '未记录明确任务拆解',
      tasks,
      decisions: [],
    },
    implementation: { changedFiles, patterns: [], components: [] },
    verification: { summary: doneMessage, commands: [], failures: [] },
    reuseHints: tasks.map((task) => `相似需求可参考：${task}`).slice(0, 8),
    constraints: [],
  })
}

export async function loadProjectMemories(projectDir: string): Promise<ProjectMemory[]> {
  const project = await resolveProjectInfo(projectDir)
  try {
    const raw = await readFile(memoryPath(project.key), 'utf8')
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => normalizeMemory(JSON.parse(line) as ProjectMemory))
      .filter((memory) => memory.id)
  } catch {
    return []
  }
}

export async function appendProjectMemory(projectDir: string, memory: ProjectMemory): Promise<void> {
  await mkdir(memoryDir(memory.project.key), { recursive: true })
  const normalized = normalizeMemory(memory)
  const existing = await loadProjectMemories(projectDir)
  if (existing.some((item) => item.source.hash === normalized.source.hash)) return
  await appendFile(memoryPath(normalized.project.key), `${JSON.stringify(normalized)}\n`, 'utf8')
}

function termWeight(term: string): number {
  if (term.includes('/') || term.includes('.') || term.length >= 8) return 5
  if (/^[a-z0-9_./-]+$/i.test(term) && term.length >= 4) return 3
  if (/[\p{Script=Han}]/u.test(term) && term.length >= 3) return 2
  return 1
}

function scoreMemory(memory: ProjectMemory, terms: string[], query: string): number {
  const strong = [
    ...memory.requirement.keywords,
    ...memory.requirement.targetModules,
    ...memory.implementation.changedFiles,
    ...memory.implementation.patterns,
    ...memory.implementation.components,
  ].join('\n').toLowerCase()
  const weak = [
    memory.requirement.summary,
    memory.plan.summary,
    ...memory.plan.tasks,
    ...memory.plan.decisions,
    ...memory.reuseHints,
  ].join('\n').toLowerCase()

  let score = 0
  for (const term of terms) {
    const weight = termWeight(term)
    if (strong.includes(term)) score += weight + 2
    else if (weak.includes(term)) score += weight
  }
  const exact = query.trim().toLowerCase()
  if (exact && (strong.includes(exact) || weak.includes(exact))) score += 8
  return score
}

export async function searchProjectMemories(projectDir: string, query: string, limit = 3): Promise<ProjectMemory[]> {
  const terms = extractMemoryTerms(query)
  if (terms.length === 0) return []
  return (await loadProjectMemories(projectDir))
    .map((memory) => ({ memory, score: scoreMemory(memory, terms, query) }))
    .filter((item) => item.score >= MIN_SEARCH_SCORE)
    .sort((a, b) => b.score - a.score || b.memory.createdAt - a.memory.createdAt)
    .slice(0, limit)
    .map((item) => item.memory)
}

export function formatProjectMemoryContext(memories: ProjectMemory[]): string {
  if (memories.length === 0) return ''
  const items = memories.map((memory, index) => [
    `记忆 ${index + 1}: ${memory.requirement.summary}`,
    `涉及文件: ${memory.implementation.changedFiles.slice(0, 6).join(', ') || '未记录'}`,
    `可复用经验: ${memory.reuseHints.slice(0, 4).join('；') || memory.plan.summary}`,
    memory.constraints.length ? `项目约束/踩坑: ${memory.constraints.slice(0, 4).join('；')}` : '',
  ].filter(Boolean).join('\n')).join('\n\n')
  return `以下内容仅供参考，不代表当前代码事实；涉及文件、接口或组件状态必须读取当前 repo 确认。\n\n${items}`
}

function normalizePinned(content: string): string {
  return content.trim().replace(/\s+/g, ' ')
}

export async function loadPinnedProjectMemories(projectDir: string): Promise<PinnedProjectMemory[]> {
  const project = await resolveProjectInfo(projectDir)
  try {
    const parsed = JSON.parse(await readFile(pinnedPath(project.key), 'utf8'))
    return Array.isArray(parsed)
      ? parsed.map((item): PinnedProjectMemory | null => {
        if (!item || typeof item !== 'object') return null
        const record = item as Record<string, unknown>
        const id = typeof record.id === 'string' ? record.id : ''
        const content = typeof record.content === 'string' ? sanitizeText(record.content, MAX_PINNED_CONTENT) : ''
        if (!id || !content) return null
        return {
          id,
          content,
          createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
          keywords: asStringArray(record.keywords, 12),
          sourceSessionId: typeof record.sourceSessionId === 'string' ? record.sourceSessionId : 'unknown',
        }
      }).filter((item): item is PinnedProjectMemory => item !== null).slice(0, MAX_PINNED)
      : []
  } catch {
    return []
  }
}

async function savePinnedProjectMemories(projectDir: string, memories: PinnedProjectMemory[]): Promise<void> {
  const project = await resolveProjectInfo(projectDir)
  await mkdir(memoryDir(project.key), { recursive: true })
  await writeFile(pinnedPath(project.key), JSON.stringify(memories.slice(0, MAX_PINNED), null, 2), 'utf8')
}

export async function appendPinnedProjectMemory(projectDir: string, content: string, sourceSessionId: string): Promise<{ memory: PinnedProjectMemory; created: boolean }> {
  const pinnedContent = sanitizeText(content, MAX_PINNED_CONTENT)
  if (!pinnedContent) throw new Error('记忆内容不能为空')
  const existing = await loadPinnedProjectMemories(projectDir)
  const duplicate = existing.find((item) => normalizePinned(item.content) === normalizePinned(pinnedContent))
  if (duplicate) return { memory: duplicate, created: false }
  const memory: PinnedProjectMemory = {
    id: `${Date.now()}-${sha(`${sourceSessionId}|${pinnedContent}`).slice(0, 10)}`,
    createdAt: Date.now(),
    content: pinnedContent,
    keywords: extractMemoryTerms(pinnedContent).slice(0, 12),
    sourceSessionId,
  }
  await savePinnedProjectMemories(projectDir, [memory, ...existing])
  return { memory, created: true }
}

export async function deletePinnedProjectMemory(projectDir: string, id: string): Promise<boolean> {
  const existing = await loadPinnedProjectMemories(projectDir)
  const next = existing.filter((item) => item.id !== id)
  if (next.length === existing.length) return false
  await savePinnedProjectMemories(projectDir, next)
  return true
}

export function formatPinnedProjectMemoryContext(memories: PinnedProjectMemory[]): string {
  return memories.slice(0, MAX_PINNED).map((memory, index) => `固定记忆 ${index + 1} [${memory.id}]: ${memory.content}`).join('\n')
}

export async function createAndStoreProjectMemory(params: {
  projectDir: string
  sessionId: string
  state: WorldState
  doneMessage: string
}): Promise<ProjectMemory | null> {
  const project = await resolveProjectInfo(params.projectDir)
  const memory = buildProjectMemory(project, params.sessionId, params.state, params.doneMessage)
  const existing = await loadProjectMemories(params.projectDir)
  if (existing.some((item) => item.source.hash === memory.source.hash)) return null
  await appendProjectMemory(params.projectDir, memory)
  return memory
}
