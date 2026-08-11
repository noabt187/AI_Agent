import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type CommandResult = {
  stdout: string
  stderr: string
}

const WINDOWS_COMMAND_SHIMS = new Set(['npm', 'npx', 'pnpm', 'yarn'])

export function resolveCommandForPlatform(
  file: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32' && WINDOWS_COMMAND_SHIMS.has(file.toLowerCase())) return `${file}.cmd`
  return file
}

function quoteCmdArgument(value: string): string {
  if (/^[a-zA-Z0-9_./:@=+,-]+$/.test(value)) return value
  return `"${value.replace(/%/g, '%%').replace(/["^]/g, '^$&')}"`
}

export function commandInvocationForPlatform(
  file: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  commandProcessor: string = process.env.ComSpec || 'cmd.exe',
): { file: string; args: string[] } {
  const resolved = resolveCommandForPlatform(file, platform)
  if (platform !== 'win32' || !resolved.toLowerCase().endsWith('.cmd')) {
    return { file: resolved, args }
  }
  const commandLine = [resolved, ...args].map(quoteCmdArgument).join(' ')
  return { file: commandProcessor, args: ['/d', '/s', '/c', commandLine] }
}

/**
 * 执行命令（超时 120s，最多 1MB 输出）
 * 所有 git / gh 操作的底层统一入口
 */
export async function runCommand(
  file: string,
  args: string[],
  cwd: string,
  timeout = 120_000,
): Promise<CommandResult> {
  const invocation = commandInvocationForPlatform(file, args)
  const result = await execFileAsync(invocation.file, invocation.args, {
    cwd,
    timeout,
    maxBuffer: 1024 * 1024,
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}
