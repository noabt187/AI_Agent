import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { WorldState } from '../orchestrator/types.js'

const execFileAsync = promisify(execFile)
const MEMORY_SCHEMA_VERSION = 2
const MIN_SEARCH_SCORE = 4
const MAX_PINNED = 20
const MAX_PINNED_CONTENT = 1000

const MEMORY_ROOT = resolve(process.cwd(), 'memory')
const LEGACY_STATE_MEMORY_ROOT = resolve(process.cwd(), 'state', 'memory')
const LEGACY_PROJECT_MEMORY_ROOT = resolve(process.cwd(), 'state', 'project-memory')

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

export type MemoryLayerId = 'session' | 'project' | 'global'

export const MEMORY_LAYER_IDS: MemoryLayerId[] = ['session', 'project', 'global']
export const MEMORY_LAYER_LABELS: Record<MemoryLayerId, string> = {
  session: '会话记忆',
  project: '项目记忆',
  global: '全局记忆',
}

export function isMemoryLayerId(value: unknown): value is MemoryLayerId {
  return value === 'session' || value === 'project' || value === 'global'
}

export type ProjectInfo = { key: string; displayName: string; rootDir: string; remoteUrl?: string }

export type ProjectMemory = {
  schemaVersion?: number
  id: string
  createdAt: number
  project: ProjectInfo
  title: string
  summary: string
  modules: string[]
  keyFiles: string[]
  decisions: string[]
  keywords: string[]
}

export type PinnedMemory = {
  id: string
  layer: MemoryLayerId
  createdAt: number
  content: string
  keywords: string[]
  sourceSessionId: string
}

export type MemoryLayer = {
  id: MemoryLayerId
  label: string
  scope: string
  paths: {
    directory: string
    pinned: string
    tasks?: string
    legacyDirectory?: string
  }
  items: PinnedMemory[]
}

export type MemoryLayersState = {
  projectInfo: ProjectInfo
  layers: MemoryLayer[]
}

type PinnedMemoryParams = {
  layer: MemoryLayerId
  projectDir?: string
  sessionId?: string
}

type PinnedMemoryTarget = {
  directory: string
  pinned: string
}

function sanitizeName(value: string, fallback = 'project'): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || fallback
}

function normalizeRemoteUrl(remoteUrl: string): string {
  return remoteUrl.trim().replace(/\.git$/i, '')
}

function remoteDisplayName(remoteUrl?: string): string | null {
  if (!remoteUrl) return null
  const normalized = normalizeRemoteUrl(remoteUrl)
  const sshMatch = normalized.match(/(?:^|:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/)
  if (sshMatch) return sshMatch[1]
  try {
    const url = new URL(normalized)
    const parts = url.pathname.split('/').filter(Boolean)
    return parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : null
  } catch {
    const parts = normalized.split('/').filter(Boolean)
    return parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : null
  }
}

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
  const displayName = remoteDisplayName(remoteUrl) ?? basename(rootDir) ?? 'project'
  const identity = remoteUrl ? normalizeRemoteUrl(remoteUrl) : rootDir
  const keyHash = sha(identity).slice(0, 12)
  const keyName = sanitizeName(displayName.replace('/', '-'))
  return { key: `${keyName}-${keyHash}`, displayName, rootDir, remoteUrl }
}

function legacyProjectKey(project: ProjectInfo): string {
  const remotePart = project.remoteUrl ?? 'no-remote'
  const name = sanitizeName(basename(project.rootDir), 'project').slice(0, 48)
  return `${name}-${sha(`${remotePart}|${project.rootDir}`).slice(0, 16)}`
}

function sessionMemoryDir(projectKey: string, sessionId: string): string {
  return resolve(projectMemoryDir(projectKey), 'sessions', sessionId)
}

function projectMemoryDir(projectKey: string): string {
  return resolve(MEMORY_ROOT, 'projects', projectKey)
}

function globalMemoryDir(): string {
  return resolve(MEMORY_ROOT, 'global')
}

function legacyStateGlobalMemoryDir(): string {
  return resolve(LEGACY_STATE_MEMORY_ROOT, 'global')
}

function legacyProjectMemoryDir(projectKey: string): string {
  return resolve(LEGACY_PROJECT_MEMORY_ROOT, projectKey)
}

function legacyStateProjectMemoryDir(projectKey: string): string {
  return resolve(LEGACY_STATE_MEMORY_ROOT, 'projects', projectKey)
}

function legacyStateSessionMemoryDir(sessionId: string): string {
  return resolve(LEGACY_STATE_MEMORY_ROOT, 'sessions', sessionId)
}

function sessionPinnedPath(projectKey: string, sessionId: string): string {
  return resolve(sessionMemoryDir(projectKey, sessionId), 'pinned.json')
}

function projectPinnedPath(projectKey: string): string {
  return resolve(projectMemoryDir(projectKey), 'pinned.json')
}

function projectTasksPath(projectKey: string): string {
  return resolve(projectMemoryDir(projectKey), 'memories.jsonl')
}

function globalPinnedPath(): string {
  return resolve(globalMemoryDir(), 'pinned.json')
}

function legacyProjectPinnedPath(projectKey: string): string {
  return resolve(legacyProjectMemoryDir(projectKey), 'pinned.json')
}

function legacyProjectTasksPath(projectKey: string): string {
  return resolve(legacyProjectMemoryDir(projectKey), 'memories.jsonl')
}

async function copyLegacyFileIfNeeded(oldPath: string, newPath: string): Promise<void> {
  try {
    await readFile(newPath, 'utf8')
    return
  } catch {}

  try {
    const raw = await readFile(oldPath, 'utf8')
    await mkdir(dirname(newPath), { recursive: true })
    await writeFile(newPath, raw, 'utf8')
  } catch {}
}

async function ensureProjectMemoryMigrated(project: ProjectInfo): Promise<void> {
  const keys = unique([project.key, legacyProjectKey(project)], 4)
  for (const key of keys) {
    await copyLegacyFileIfNeeded(resolve(legacyStateProjectMemoryDir(key), 'pinned.json'), projectPinnedPath(project.key))
    await copyLegacyFileIfNeeded(resolve(legacyStateProjectMemoryDir(key), 'memories.jsonl'), projectTasksPath(project.key))
    await copyLegacyFileIfNeeded(legacyProjectPinnedPath(key), projectPinnedPath(project.key))
    await copyLegacyFileIfNeeded(legacyProjectTasksPath(key), projectTasksPath(project.key))
  }
}

async function ensureSessionMemoryMigrated(project: ProjectInfo, sessionId: string): Promise<void> {
  await copyLegacyFileIfNeeded(resolve(legacyStateSessionMemoryDir(sessionId), 'pinned.json'), sessionPinnedPath(project.key, sessionId))
}

async function ensureGlobalMemoryMigrated(): Promise<void> {
  await copyLegacyFileIfNeeded(resolve(legacyStateGlobalMemoryDir(), 'pinned.json'), globalPinnedPath())
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

export function extractMemoryTerms(text: string): string[] {
  const terms = new Set<string>()
  const normalized = text.toLowerCase()
  for (const term of normalized.match(/[a-z0-9_./-]{2,}/g) ?? []) terms.add(term)
  for (const match of normalized.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const block = match[0]
    if (block.length <= 12) terms.add(block)
    for (let i = 0; i < block.length - 2; i += 1) terms.add(block.slice(i, i + 3))
  }
  return Array.from(terms).filter((term) => term.length >= 2 && !GENERIC_TERMS.has(term))
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function normalizeProjectRecord(value: unknown): ProjectInfo {
  const record = asRecord(value)
  const rootDir = stringValue(record, 'rootDir') || process.cwd()
  const remoteUrl = stringValue(record, 'remoteUrl') || undefined
  const displayName = stringValue(record, 'displayName') || remoteDisplayName(remoteUrl) || basename(rootDir) || 'project'
  const key = stringValue(record, 'key') || `${sanitizeName(displayName.replace('/', '-'))}-${sha(remoteUrl ?? rootDir).slice(0, 12)}`
  return { key, displayName, rootDir, remoteUrl }
}

function firstSentence(text: string, limit = 80): string {
  const clean = sanitizeText(text, limit * 2).replace(/\s+/g, ' ')
  const [first] = clean.split(/[。.!?\n]/)
  return (first || clean).trim().slice(0, limit)
}

function readableMemoryId(title: string, createdAt: number): string {
  const date = new Date(createdAt)
  const datePart = Number.isNaN(date.getTime())
    ? 'memory'
    : `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `${datePart}-${slug || 'memory'}`
}

function inferModuleFromFile(file: string): string {
  const parts = file.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts[0] === 'frontend' && parts[1] === 'src') return ['frontend', parts[2], parts[3]].filter(Boolean).join('/')
  if (parts[0] === 'backend') return ['backend', parts[1], parts[2]].filter(Boolean).join('/')
  return parts.slice(0, 3).join('/')
}

function normalizeMemory(memory: unknown): ProjectMemory {
  const record = asRecord(memory)
  const requirement = asRecord(record.requirement)
  const plan = asRecord(record.plan)
  const implementation = asRecord(record.implementation)
  const createdAt = typeof record.createdAt === 'number' ? record.createdAt : Date.now()
  const summary = sanitizeText(
    stringValue(record, 'summary')
      || stringValue(requirement, 'summary')
      || stringValue(plan, 'summary'),
    500,
  )
  const title = firstSentence(stringValue(record, 'title') || summary || '项目记忆', 48)
  const keyFiles = unique([
    ...asStringArray(record.keyFiles, 8),
    ...asStringArray(implementation.changedFiles, 8),
  ], 8)
  const modules = unique([
    ...asStringArray(record.modules, 8),
    ...asStringArray(requirement.targetModules, 8),
    ...keyFiles.map(inferModuleFromFile),
  ], 8)
  const decisions = unique([
    ...asStringArray(record.decisions, 8),
    ...asStringArray(plan.decisions, 8),
  ].map((item) => sanitizeText(item, 160)), 8)
  const keywords = unique([
    ...asStringArray(record.keywords, 12),
    ...asStringArray(requirement.keywords, 12),
    ...extractMemoryTerms(`${title}\n${summary}\n${modules.join('\n')}\n${keyFiles.join('\n')}`),
  ], 12)

  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id: stringValue(record, 'id') || readableMemoryId(title, createdAt),
    createdAt,
    project: normalizeProjectRecord(record.project),
    title,
    summary,
    modules,
    keyFiles,
    decisions,
    keywords,
  }
}

function buildProjectMemory(project: ProjectInfo, state: WorldState, doneMessage: string): ProjectMemory {
  const requirementSummary = state.confirmedRequirement || state.goal || doneMessage
  const tasks = state.designTasks?.map((task) => firstSentence(task.title || task.description, 80)) ?? []
  const changedFiles = unique(state.designTasks?.map((task) => task.file) ?? [], 8)
  const targetModules = unique(changedFiles.map(inferModuleFromFile), 8)
  const createdAt = Date.now()
  const title = firstSentence(requirementSummary || doneMessage || '项目记忆', 48)

  return normalizeMemory({
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id: readableMemoryId(title, createdAt),
    createdAt,
    project,
    title,
    summary: requirementSummary,
    modules: targetModules,
    keyFiles: changedFiles,
    decisions: tasks,
    keywords: extractMemoryTerms(`${requirementSummary}\n${doneMessage}\n${changedFiles.join('\n')}`).slice(0, 12),
  })
}

export async function loadProjectMemories(projectDir: string): Promise<ProjectMemory[]> {
  const project = await resolveProjectInfo(projectDir)
  await ensureProjectMemoryMigrated(project)
  try {
    const raw = await readFile(projectTasksPath(project.key), 'utf8')
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
  await ensureProjectMemoryMigrated(memory.project)
  await mkdir(projectMemoryDir(memory.project.key), { recursive: true })
  const normalized = normalizeMemory(memory)
  const existing = await loadProjectMemories(projectDir)
  if (hasProjectMemory(existing, normalized)) return
  await appendFile(projectTasksPath(normalized.project.key), `${JSON.stringify(normalized)}\n`, 'utf8')
}

function hasProjectMemory(memories: ProjectMemory[], candidate: ProjectMemory): boolean {
  return memories.some((item) => item.id === candidate.id || (item.title === candidate.title && item.summary === candidate.summary))
}

function termWeight(term: string): number {
  if (term.includes('/') || term.includes('.') || term.length >= 8) return 5
  if (/^[a-z0-9_./-]+$/i.test(term) && term.length >= 4) return 3
  if (/[\p{Script=Han}]/u.test(term) && term.length >= 3) return 2
  return 1
}

function scoreMemory(memory: ProjectMemory, terms: string[], query: string): number {
  const strong = [
    ...memory.keywords,
    ...memory.modules,
    ...memory.keyFiles,
  ].join('\n').toLowerCase()
  const weak = [
    memory.title,
    memory.summary,
    ...memory.decisions,
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

function normalizePinned(content: string): string {
  return content.trim().replace(/\s+/g, ' ')
}

export function formatProjectMemoryContext(memories: ProjectMemory[]): string {
  if (memories.length === 0) return ''
  const items = memories.map((memory, index) => [
    `项目记忆 ${index + 1}: ${memory.title}`,
    `模块: ${memory.modules.slice(0, 5).join(', ') || '未记录'}`,
    `经验: ${memory.summary}`,
    memory.keyFiles.length ? `关键文件: ${memory.keyFiles.slice(0, 5).join(', ')}` : '',
    memory.decisions.length ? `决策: ${memory.decisions.slice(0, 4).join('；')}` : '',
  ].filter(Boolean).join('\n')).join('\n\n')
  return `以下项目记忆仅供参考；涉及文件、接口或组件状态时，仍需读取当前 repo 确认。\n\n${items}`
}

function normalizePinnedRecord(item: unknown, layer: MemoryLayerId): PinnedMemory | null {
  const record = asRecord(item)
  const id = typeof record.id === 'string' ? record.id : ''
  const content = typeof record.content === 'string' ? sanitizeText(record.content, MAX_PINNED_CONTENT) : ''
  if (!id || !content) return null
  return {
    id,
    layer: isMemoryLayerId(record.layer) ? record.layer : layer,
    content,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
    keywords: asStringArray(record.keywords, 12),
    sourceSessionId: typeof record.sourceSessionId === 'string' ? record.sourceSessionId : 'unknown',
  }
}

async function resolvePinnedTarget(params: PinnedMemoryParams): Promise<PinnedMemoryTarget> {
  if (params.layer === 'session') {
    if (!params.sessionId) throw new Error('session memory requires sessionId')
    const project = await resolveProjectInfo(params.projectDir ?? process.cwd())
    await ensureSessionMemoryMigrated(project, params.sessionId)
    return { directory: sessionMemoryDir(project.key, params.sessionId), pinned: sessionPinnedPath(project.key, params.sessionId) }
  }
  if (params.layer === 'global') {
    await ensureGlobalMemoryMigrated()
    return { directory: globalMemoryDir(), pinned: globalPinnedPath() }
  }
  const project = await resolveProjectInfo(params.projectDir ?? process.cwd())
  await ensureProjectMemoryMigrated(project)
  return { directory: projectMemoryDir(project.key), pinned: projectPinnedPath(project.key) }
}

export async function loadPinnedMemories(params: PinnedMemoryParams): Promise<PinnedMemory[]> {
  const target = await resolvePinnedTarget(params)
  try {
    const parsed = JSON.parse(await readFile(target.pinned, 'utf8'))
    return Array.isArray(parsed)
      ? parsed
        .map((item) => normalizePinnedRecord(item, params.layer))
        .filter((item): item is PinnedMemory => item !== null)
        .slice(0, MAX_PINNED)
      : []
  } catch {
    return []
  }
}

async function savePinnedMemories(params: PinnedMemoryParams, memories: PinnedMemory[]): Promise<void> {
  const target = await resolvePinnedTarget(params)
  await mkdir(target.directory, { recursive: true })
  await writeFile(target.pinned, JSON.stringify(memories.slice(0, MAX_PINNED), null, 2), 'utf8')
}

export async function appendPinnedMemory(params: PinnedMemoryParams & {
  content: string
  sourceSessionId: string
}): Promise<{ memory: PinnedMemory; created: boolean }> {
  const pinnedContent = sanitizeText(params.content, MAX_PINNED_CONTENT)
  if (!pinnedContent) throw new Error('记忆内容不能为空')
  const existing = await loadPinnedMemories(params)
  const duplicate = existing.find((item) => normalizePinned(item.content) === normalizePinned(pinnedContent))
  if (duplicate) return { memory: duplicate, created: false }
  const memory: PinnedMemory = {
    id: `${params.layer}-${Date.now()}-${sha(`${params.sourceSessionId}|${pinnedContent}`).slice(0, 10)}`,
    layer: params.layer,
    createdAt: Date.now(),
    content: pinnedContent,
    keywords: extractMemoryTerms(pinnedContent).slice(0, 12),
    sourceSessionId: params.sourceSessionId,
  }
  await savePinnedMemories(params, [memory, ...existing])
  return { memory, created: true }
}

export async function deletePinnedMemory(params: PinnedMemoryParams & {
  id: string
}): Promise<boolean> {
  const existing = await loadPinnedMemories(params)
  const next = existing.filter((item) => item.id !== params.id)
  if (next.length === existing.length) return false
  await savePinnedMemories(params, next)
  return true
}

export async function deletePinnedMemoryById(projectDir: string, sessionId: string, id: string): Promise<{ deleted: boolean; layer?: MemoryLayerId }> {
  for (const layer of MEMORY_LAYER_IDS) {
    const deleted = await deletePinnedMemory({ layer, id, projectDir, sessionId })
    if (deleted) return { deleted: true, layer }
  }
  return { deleted: false }
}

export async function loadMemoryLayers(projectDir: string, sessionId: string): Promise<MemoryLayersState> {
  const projectInfo = await resolveProjectInfo(projectDir)
  const [sessionItems, projectItems, globalItems] = await Promise.all([
    loadPinnedMemories({ layer: 'session', projectDir, sessionId }),
    loadPinnedMemories({ layer: 'project', projectDir }),
    loadPinnedMemories({ layer: 'global' }),
  ])

  return {
    projectInfo,
    layers: [
      {
        id: 'session',
        label: MEMORY_LAYER_LABELS.session,
        scope: '只在当前会话生效',
        paths: {
          directory: sessionMemoryDir(projectInfo.key, sessionId),
          pinned: sessionPinnedPath(projectInfo.key, sessionId),
        },
        items: sessionItems,
      },
      {
        id: 'project',
        label: MEMORY_LAYER_LABELS.project,
        scope: '在当前项目的所有会话生效',
        paths: {
          directory: projectMemoryDir(projectInfo.key),
          pinned: projectPinnedPath(projectInfo.key),
          tasks: projectTasksPath(projectInfo.key),
          legacyDirectory: legacyProjectMemoryDir(projectInfo.key),
        },
        items: projectItems,
      },
      {
        id: 'global',
        label: MEMORY_LAYER_LABELS.global,
        scope: '在所有项目和会话生效',
        paths: {
          directory: globalMemoryDir(),
          pinned: globalPinnedPath(),
        },
        items: globalItems,
      },
    ],
  }
}

export function formatPinnedMemoryContext(label: string, memories: PinnedMemory[]): string {
  return memories.slice(0, MAX_PINNED).map((memory, index) => `${label} ${index + 1} [${memory.id}]: ${memory.content}`).join('\n')
}

export async function createAndStoreProjectMemory(params: {
  projectDir: string
  sessionId: string
  state: WorldState
  doneMessage: string
}): Promise<ProjectMemory | null> {
  const project = await resolveProjectInfo(params.projectDir)
  const memory = buildProjectMemory(project, params.state, params.doneMessage)
  const existing = await loadProjectMemories(params.projectDir)
  if (hasProjectMemory(existing, memory)) return null
  await appendProjectMemory(params.projectDir, memory)
  return memory
}
