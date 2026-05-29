import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Message } from '../types/index.js'

const stateDir = resolve(process.cwd(), 'state')

function getSessionDir(sessionId: string): string {
  return resolve(stateDir, sessionId)
}

function getMessagesPath(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'messages.json')
}

function getMessagesBackupPath(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'messages-full.json')
}

function getOrchestratorStatePath(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'orchestrator-state.json')
}

export async function listAllSessionIds(): Promise<string[]> {
  await mkdir(stateDir, { recursive: true })
  const entries = await readdir(stateDir)
  const results: string[] = []
  for (const entry of entries) {
    const fullPath = resolve(stateDir, entry)
    const s = await stat(fullPath)
    if (s.isDirectory()) {
      const msgPath = getMessagesPath(entry)
      try {
        await stat(msgPath)
        results.push(entry)
      } catch {}
    }
  }
  return results
}

export async function loadMessages(sessionId: string): Promise<Message[]> {
  const path = getMessagesPath(sessionId)
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function saveMessages(sessionId: string, messages: Message[]): Promise<void> {
  const sessionDir = getSessionDir(sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(getMessagesPath(sessionId), JSON.stringify(messages, null, 2), 'utf8')
}

export async function saveMessagesBackup(sessionId: string, messages: Message[]): Promise<void> {
  const sessionDir = getSessionDir(sessionId)
  await mkdir(sessionDir, { recursive: true })
  const path = getMessagesBackupPath(sessionId)
  // Append to backup: merge with existing, dedup by uuid
  let existing: Message[] = []
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) existing = parsed
  } catch {}
  const existingIds = new Set(existing.map((m) => m.uuid))
  const newMessages = messages.filter((m) => !existingIds.has(m.uuid))
  if (newMessages.length > 0) {
    existing.push(...newMessages)
    await writeFile(path, JSON.stringify(existing, null, 2), 'utf8')
  }
}

export async function loadOrchestratorState<T>(sessionId: string): Promise<T | null> {
  const path = getOrchestratorStatePath(sessionId)
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function saveOrchestratorState<T>(sessionId: string, state: T): Promise<void> {
  const sessionDir = getSessionDir(sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(getOrchestratorStatePath(sessionId), JSON.stringify(state, null, 2), 'utf8')
}

function getConversationContextPath(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'conversation-context.json')
}

export async function loadConversationContext<T>(sessionId: string): Promise<T | null> {
  const path = getConversationContextPath(sessionId)
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function saveConversationContext<T>(sessionId: string, context: T): Promise<void> {
  const sessionDir = getSessionDir(sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(getConversationContextPath(sessionId), JSON.stringify(context, null, 2), 'utf8')
}

export type RequirementAnalysisTurn = {
  turnIndex: number
  timestamp: number
  depth: number
  userInput: string
  compressedContext: string | null
  systemPrompt: string
  effectiveInput: string
  rawOutput: string
  parsedResult: unknown
}

export type RequirementAnalysisSession = {
  requirementId: string
  startedAt: number
  userInput: string
  turns: RequirementAnalysisTurn[]
}

function getRequirementAnalysisLogPath(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'requirement-analysis-log.json')
}

export async function loadRequirementAnalysisLog(sessionId: string): Promise<RequirementAnalysisSession[]> {
  const path = getRequirementAnalysisLogPath(sessionId)
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
    // Migrate old format: turns array → sessions array
    return []
  } catch {
    return []
  }
}

export async function appendRequirementAnalysisSession(
  sessionId: string,
  session: RequirementAnalysisSession,
): Promise<void> {
  const sessionDir = getSessionDir(sessionId)
  await mkdir(sessionDir, { recursive: true })
  const existing = await loadRequirementAnalysisLog(sessionId)
  existing.push(session)
  await writeFile(getRequirementAnalysisLogPath(sessionId), JSON.stringify(existing, null, 2), 'utf8')
}

export type CodeGenerationTurn = {
  turnIndex: number
  timestamp: number
  depth: number
  taskInput: string
  systemPrompt: string
  effectiveInput: string
  rawOutput: string
  parsedResult: unknown
}

export type CodeGenerationTaskLog = {
  taskId: string
  title: string
  attempts: {
    attempt: number
    timestamp: number
    turns: CodeGenerationTurn[]
    result: 'success' | 'failed'
    writtenFiles: string[]
    summary: string
    error?: string
  }[]
}

export type CodeGenerationLog = {
  startedAt: number
  projectPath: string
  allowedPaths: string[]
  tasks: CodeGenerationTaskLog[]
  completedAt?: number
}

function getCodeGenerationLogPath(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'code-generation-log.json')
}

export async function loadCodeGenerationLog(sessionId: string): Promise<CodeGenerationLog | null> {
  const path = getCodeGenerationLogPath(sessionId)
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as CodeGenerationLog
  } catch {
    return null
  }
}

export async function saveCodeGenerationLog(sessionId: string, log: CodeGenerationLog): Promise<void> {
  const sessionDir = getSessionDir(sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(getCodeGenerationLogPath(sessionId), JSON.stringify(log, null, 2), 'utf8')
}

// ── Compression Failure Counter (Circuit Breaker) ───────────────────

function getCompressionFailuresPath(sessionId: string): string {
  return resolve(getSessionDir(sessionId), 'compression-failures.json')
}

export async function getCompressionFailureCount(sessionId: string): Promise<number> {
  const path = getCompressionFailuresPath(sessionId)
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed.count === 'number' ? parsed.count : 0
  } catch {
    return 0
  }
}

export async function incrementCompressionFailure(sessionId: string): Promise<number> {
  const sessionDir = getSessionDir(sessionId)
  await mkdir(sessionDir, { recursive: true })
  const count = (await getCompressionFailureCount(sessionId)) + 1
  await writeFile(getCompressionFailuresPath(sessionId), JSON.stringify({ count }), 'utf8')
  return count
}

export async function resetCompressionFailures(sessionId: string): Promise<void> {
  const sessionDir = getSessionDir(sessionId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(getCompressionFailuresPath(sessionId), JSON.stringify({ count: 0 }), 'utf8')
}
