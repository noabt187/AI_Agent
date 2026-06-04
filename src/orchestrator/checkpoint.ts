import { exec } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CheckpointSnapshot, WorldState } from './types.js'

// ── Types ───────────────────────────────────────────────────────────

type CodeCheckpointEntry = {
  label: string
  commitHash: string
  timestamp: number
  snapshot: CheckpointSnapshot
}

const CHECKPOINT_MSG_PREFIX = '[checkpoint]'

// ── Git helpers ─────────────────────────────────────────────────────

function git(cwd: string, args: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(`git ${args}`, { cwd, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message))
      else resolve(stdout.trim())
    })
  })
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await git(dir, 'rev-parse --is-inside-work-tree')
    return true
  } catch {
    return false
  }
}

// ── Snapshot extraction ─────────────────────────────────────────────

function extractSnapshot(state: WorldState): CheckpointSnapshot {
  return {
    goal: state.goal,
    confirmedRequirement: state.confirmedRequirement,
    designTasks: state.designTasks ? [...state.designTasks] : undefined,
    completedTaskIds: [...state.completedTaskIds],
    failedTaskIds: [...state.failedTaskIds],
    phase: state.phase,
  }
}

// ── Design Checkpoint (file-based, no git, only latest) ─────────────

function getDesignCheckpointPath(sessionId: string): string {
  return resolve(process.cwd(), 'state', sessionId, 'design-checkpoint.json')
}

export async function saveDesignCheckpoint(sessionId: string, state: WorldState): Promise<void> {
  const path = getDesignCheckpointPath(sessionId)
  await mkdir(resolve(path, '..'), { recursive: true })
  const snapshot = extractSnapshot(state)
  await writeFile(path, JSON.stringify(snapshot, null, 2), 'utf8')
}

export async function loadDesignCheckpoint(sessionId: string): Promise<CheckpointSnapshot | null> {
  try {
    const raw = await readFile(getDesignCheckpointPath(sessionId), 'utf8')
    return JSON.parse(raw) as CheckpointSnapshot
  } catch {
    return null
  }
}

// ── Code Checkpoint (git-based, list of entries) ────────────────────

function getCodeCheckpointsPath(sessionId: string): string {
  return resolve(process.cwd(), 'state', sessionId, 'code-checkpoints.json')
}

async function loadCodeCheckpointEntries(sessionId: string): Promise<CodeCheckpointEntry[]> {
  try {
    const raw = await readFile(getCodeCheckpointsPath(sessionId), 'utf8')
    return JSON.parse(raw) as CodeCheckpointEntry[]
  } catch {
    return []
  }
}

async function saveCodeCheckpointEntries(sessionId: string, entries: CodeCheckpointEntry[]): Promise<void> {
  const path = getCodeCheckpointsPath(sessionId)
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(entries, null, 2), 'utf8')
}

export async function createCodeCheckpoint(
  sessionId: string,
  label: string,
  state: WorldState,
): Promise<void> {
  const projectDir = state.allowedPaths[0]
  if (!projectDir || !(await isGitRepo(projectDir))) return

  const snapshot = extractSnapshot(state)
  const timestamp = Date.now()

  let commitHash = ''
  try {
    await git(projectDir, 'add -A')
    try {
      await git(projectDir, `commit -m "${CHECKPOINT_MSG_PREFIX} ${label} - ${sessionId}" --allow-empty`)
    } catch {}
    commitHash = await git(projectDir, 'rev-parse HEAD')
  } catch {
    return
  }

  const entries = await loadCodeCheckpointEntries(sessionId)
  entries.push({ label, commitHash, timestamp, snapshot })
  await saveCodeCheckpointEntries(sessionId, entries)
}

export async function restoreCodeCheckpoint(
  sessionId: string,
  targetLabel: string,
  state: WorldState,
): Promise<CheckpointSnapshot | null> {
  const projectDir = state.allowedPaths[0]
  if (!projectDir || !(await isGitRepo(projectDir))) return null

  const entries = await loadCodeCheckpointEntries(sessionId)
  const target = entries.find((e) => e.label === targetLabel)
  if (!target) return null

  try {
    await git(projectDir, `reset --hard ${target.commitHash}`)

    // 清理该 checkpoint 之后的记录
    const targetIdx = entries.indexOf(target)
    const filtered = entries.slice(0, targetIdx + 1)
    await saveCodeCheckpointEntries(sessionId, filtered)

    return target.snapshot
  } catch {
    return null
  }
}

export async function listCodeCheckpoints(sessionId: string): Promise<CodeCheckpointEntry[]> {
  return loadCodeCheckpointEntries(sessionId)
}

// ── Apply snapshot to WorldState ────────────────────────────────────

export function applySnapshot(state: WorldState, snapshot: CheckpointSnapshot): void {
  state.goal = snapshot.goal
  state.confirmedRequirement = snapshot.confirmedRequirement
  state.designTasks = snapshot.designTasks
  state.completedTaskIds = [...snapshot.completedTaskIds]
  state.failedTaskIds = [...snapshot.failedTaskIds]
  state.phase = snapshot.phase ? (snapshot.phase as import('./types.js').AgentPhase) : undefined
  state.pendingConfirm = undefined
  state.designConfirmed = false
}
