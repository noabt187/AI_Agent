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

// npm.cmd is a script, not an executable. Node launches the CLI without shell interpolation.
function resolveCommand(file: string, args: string[]): { file: string; args: string[] } {
  const name = basename(file).toLowerCase().replace(/\.(cmd|ps1)$/, '')
  if (process.platform !== 'win32' || !['npm', 'npx'].includes(name)) return { file, args }
  const nodeDir = dirname(realpathSync(process.execPath))
  const directories = file.includes('/') || file.includes('\\')
    ? [dirname(file)]
    : [nodeDir, dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter)]
  for (const dir of directories) {
    const cli = join(dir.replace(/^"|"$/g, ''), 'node_modules', 'npm', 'bin', `${name}-cli.js`)
    if (existsSync(cli)) return { file: process.execPath, args: [cli, ...args] }
  }
  throw new CommandError('start', `无法定位 ${name} CLI（Windows 脚本入口）；请检查 Node/npm 安装路径`, '', '', null, 'ENOENT')
}

export async function runCommand(
  file: string, args: string[], cwd: string, timeout = 120_000, signal?: AbortSignal,
): Promise<CommandResult> {
  if (signal?.aborted) throw new CommandError('aborted', '命令已取消')
  const resolved = resolveCommand(file, args)
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
