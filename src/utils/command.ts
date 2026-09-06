import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'

export type CommandResult = { stdout: string; stderr: string }
export type CommandFailureKind = 'start' | 'exit' | 'timeout' | 'aborted' | 'output-limit'

export class CommandError extends Error {
  constructor(
    public readonly kind: CommandFailureKind,
    message: string,
    public readonly stdout = '',
    public readonly stderr = '',
    public readonly exitCode: number | null = null,
    public readonly code?: string,
  ) { super(message); this.name = 'CommandError' }
}

const WINDOWS_PACKAGE_CLIS: Record<string, string[]> = {
  npm: ['npm/bin/npm-cli.js'],
  npx: ['npm/bin/npx-cli.js'],
  pnpm: ['pnpm/bin/pnpm.cjs', 'pnpm/bin/pnpm.js', 'corepack/dist/pnpm.js'],
  yarn: ['yarn/bin/yarn.js', 'corepack/dist/yarn.js'],
}

export function resolveCommandForPlatform(file: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' && Object.hasOwn(WINDOWS_PACKAGE_CLIS, file.toLowerCase())
    ? `${file}.cmd` : file
}

/** Launch package-manager JavaScript directly: arguments never pass through cmd interpolation. */
export function commandInvocationForPlatform(
  file: string, args: string[], platform: NodeJS.Platform = process.platform,
  searchDirectories?: readonly string[],
): { file: string; args: string[] } {
  const name = basename(resolveCommandForPlatform(file, platform)).toLowerCase().replace(/\.(cmd|ps1)$/, '')
  if (platform !== 'win32' || !Object.hasOwn(WINDOWS_PACKAGE_CLIS, name)) return { file, args }
  const nodeDir = dirname(realpathSync(process.execPath))
  const directories = searchDirectories ?? (file.includes('/') || file.includes('\\')
    ? [dirname(file)]
    : [nodeDir, dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter)])
  for (const directory of directories) {
    const dir = directory.replace(/^"|"$/g, '')
    if (!dir) continue
    for (const entry of WINDOWS_PACKAGE_CLIS[name]) {
      const cli = join(dir, 'node_modules', entry)
      if (existsSync(cli)) return { file: process.execPath, args: [cli, ...args] }
    }
    const executable = join(dir, `${name}.exe`)
    if (existsSync(executable)) return { file: executable, args }
  }
  throw new CommandError('start', `无法定位 ${name} CLI（Windows 脚本入口）；请检查包管理器安装路径`, '', '', null, 'ENOENT')
}

export async function runCommand(
  file: string, args: string[], cwd: string, timeout = 120_000, signal?: AbortSignal,
): Promise<CommandResult> {
  if (signal?.aborted) throw new CommandError('aborted', '命令已取消')
  const resolved = commandInvocationForPlatform(file, args)
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', bytes = 0
    let stopped: CommandFailureKind | undefined
    let finished = false
    const child = spawn(resolved.file, resolved.args, {
      cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stop = (kind: CommandFailureKind) => {
      if (stopped || finished) return
      stopped = kind
      if (!child.pid) return
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => { child.kill() })
        killer.on('exit', code => { if (code !== 0) child.kill() })
      } else {
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      }
    }
    const onAbort = () => stop('aborted')
    const timer = setTimeout(() => stop('timeout'), timeout)
    const cleanup = () => { finished = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
    const collect = (chunk: string, stream: 'stdout' | 'stderr') => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 1024 * 1024) { stop('output-limit'); return }
      if (stream === 'stdout') stdout += chunk
      else stderr += chunk
    }
    child.stdout.setEncoding('utf8').on('data', chunk => collect(chunk, 'stdout'))
    child.stderr.setEncoding('utf8').on('data', chunk => collect(chunk, 'stderr'))
    child.once('error', error => {
      cleanup()
      reject(new CommandError(stopped ?? 'start', error.message, stdout, stderr, null, (error as NodeJS.ErrnoException).code))
    })
    child.once('close', (code, exitSignal) => {
      if (finished) return
      cleanup()
      if (stopped || code !== 0) {
        reject(new CommandError(stopped ?? 'exit', `${file}: ${stopped ?? `退出码 ${code ?? exitSignal}`}`, stdout, stderr, code))
      } else resolve({ stdout, stderr })
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}
