import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const MAX_CHECKPOINT_FILE_BYTES = 5 * 1024 * 1024

export type CheckpointContext = {
  sessionId: string
  taskId: string
  authorizationId: number
  stateRoot?: string
}

type FileCheckpoint = {
  path: string
  existed: boolean
  size: number
  sha256?: string
  mode?: number
  contentBase64?: string
}

export type CheckpointManifest = {
  sessionId: string
  taskId: string
  authorizationId: number
  createdAt: string
  files: FileCheckpoint[]
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function manifestPath(context: CheckpointContext): string {
  const stateRoot = context.stateRoot ?? resolve(process.cwd(), 'state')
  return resolve(
    stateRoot,
    safeSegment(context.sessionId),
    'checkpoints',
    `${safeSegment(context.taskId)}-${context.authorizationId}.json`,
  )
}

async function loadManifest(context: CheckpointContext): Promise<CheckpointManifest> {
  const path = manifestPath(context)
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as CheckpointManifest
    if (Array.isArray(parsed.files)) return parsed
  } catch {}
  return {
    sessionId: context.sessionId,
    taskId: context.taskId,
    authorizationId: context.authorizationId,
    createdAt: new Date().toISOString(),
    files: [],
  }
}

async function saveManifest(context: CheckpointContext, manifest: CheckpointManifest): Promise<void> {
  const path = manifestPath(context)
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tempPath, JSON.stringify(manifest, null, 2), 'utf8')
  await rename(tempPath, path)
}

function normalizedKey(filePath: string): string {
  const absolute = resolve(filePath)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export async function captureFileCheckpoint(
  context: CheckpointContext,
  filePath: string,
): Promise<CheckpointManifest> {
  const absolute = resolve(filePath)
  const manifest = await loadManifest(context)
  const key = normalizedKey(absolute)
  if (manifest.files.some((item) => normalizedKey(item.path) === key)) return manifest

  let record: FileCheckpoint
  try {
    const info = await stat(absolute)
    if (!info.isFile()) throw new Error(`Checkpoint 只支持文件，当前路径不是普通文件: ${absolute}`)
    if (info.size > MAX_CHECKPOINT_FILE_BYTES) {
      throw new Error(`文件超过 ${MAX_CHECKPOINT_FILE_BYTES} 字节的 Checkpoint 上限: ${absolute}`)
    }
    const content = await readFile(absolute)
    record = {
      path: absolute,
      existed: true,
      size: info.size,
      sha256: createHash('sha256').update(content).digest('hex'),
      mode: info.mode,
      contentBase64: content.toString('base64'),
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error
    record = { path: absolute, existed: false, size: 0 }
  }

  manifest.files.push(record)
  await saveManifest(context, manifest)
  return manifest
}

export async function restoreCheckpoint(context: CheckpointContext): Promise<CheckpointManifest> {
  const manifest = await loadManifest(context)
  for (const record of [...manifest.files].reverse()) {
    if (!record.existed) {
      await rm(record.path, { force: true })
      continue
    }
    await mkdir(dirname(record.path), { recursive: true })
    await writeFile(record.path, Buffer.from(record.contentBase64 ?? '', 'base64'))
    if (record.mode !== undefined) {
      try { await chmod(record.path, record.mode) } catch {}
    }
  }
  return manifest
}

export async function readCheckpoint(context: CheckpointContext): Promise<CheckpointManifest> {
  return loadManifest(context)
}
