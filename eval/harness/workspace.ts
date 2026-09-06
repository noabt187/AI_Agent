import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { EvalTask } from '../types.js'

const execFileAsync = promisify(execFile)
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist'])

export async function prepareTrialWorkspace(
  task: EvalTask,
  runsRoot: string,
  trialId: string,
): Promise<{ workspace: string; baseline: Record<string, string> }> {
  const workspace = resolve(runsRoot, 'workspaces', trialId)
  await mkdir(workspace, { recursive: true })

  for (const [relativePath, content] of Object.entries(task.fixture)) {
    const filePath = resolve(workspace, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content, 'utf8')
  }

  await execFileAsync('git', ['init'], { cwd: workspace })
  await execFileAsync('git', ['config', 'user.name', 'Agent Eval'], { cwd: workspace })
  await execFileAsync('git', ['config', 'user.email', 'agent-eval@example.invalid'], { cwd: workspace })
  await execFileAsync('git', ['add', '-A'], { cwd: workspace })
  await execFileAsync('git', ['commit', '-m', 'eval fixture baseline'], { cwd: workspace })

  return { workspace, baseline: await snapshotWorkspace(workspace) }
}

export async function snapshotWorkspace(rootDir: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {}

  async function walk(directory: string, prefix = ''): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolutePath = join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolutePath, relativePath)
      else if (entry.isFile()) snapshot[relativePath.replaceAll('\\', '/')] = await readFile(absolutePath, 'utf8')
    }
  }

  await walk(rootDir)
  return snapshot
}

export function diffSnapshots(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const allFiles = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...allFiles].filter((file) => before[file] !== after[file]).sort()
}
