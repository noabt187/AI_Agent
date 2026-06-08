import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type CommandResult = {
  stdout: string
  stderr: string
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
  const result = await execFileAsync(file, args, {
    cwd,
    timeout,
    maxBuffer: 1024 * 1024,
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}
