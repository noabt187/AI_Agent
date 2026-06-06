import { spawn } from 'node:child_process'

// 命令白名单：只允许验证类命令，禁止任意 shell 执行
const ALLOWED_COMMANDS = new Set([
  'npm test', 'npm run test', 'npm run build', 'npm run lint', 'npm run format',
  'npx vitest --run', 'npx jest', 'npx eslint', 'npx prettier',
  'yarn test', 'yarn build', 'yarn lint',
  'pnpm test', 'pnpm build', 'pnpm lint',
])

function isCommandAllowed(command: string): boolean {
  const trimmed = command.trim()
  if (ALLOWED_COMMANDS.has(trimmed)) return true
  if (/^npm run [\w:.-]+$/.test(trimmed)) return true
  const cdMatch = trimmed.match(/^cd\s+[\w./\\-]+\s*&&\s*(.+)$/)
  if (cdMatch) return isCommandAllowed(cdMatch[1])
  return false
}

function splitCommand(full: string): { cmd: string; args: string[] } {
  const trimmed = full.trim()
  // Handle "cd path && cmd args"
  const cdMatch = trimmed.match(/^cd\s+([\w./\\-]+)\s*&&\s*(.+)$/)
  if (cdMatch) {
    const targetDir = cdMatch[1]
    const rest = cdMatch[2]
    // Use shell to handle cd chaining
    if (process.platform === 'win32') {
      return { cmd: 'cmd', args: ['/c', `cd /d ${targetDir} && ${rest}`] }
    }
    return { cmd: '/bin/sh', args: ['-c', `cd "${targetDir}" && ${rest}`] }
  }

  const parts = trimmed.split(/\s+/)
  // On Windows, npm scripts run via cmd /c
  if (process.platform === 'win32') {
    return { cmd: 'cmd', args: ['/c', trimmed] }
  }
  return { cmd: parts[0], args: parts.slice(1) }
}

export function execCommandTool(
  rootDir: string,
  command: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!isCommandAllowed(command)) {
    return Promise.resolve(
      `错误：命令 "${command}" 不在白名单中。允许的命令：npm test, npm run build, npm run lint, npm run format 等验证类命令。`,
    )
  }

  return new Promise((resolve) => {
    const { cmd, args } = splitCommand(command)
    const timeoutMs = 60000

    const child = spawn(cmd, args, {
      cwd: rootDir,
      timeout: timeoutMs,
      signal,      // ← 关键：abort 时 Node 自动 SIGTERM → SIGKILL
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('close', (code, sig) => {
      if (sig) {
        resolve(`[已终止] 命令被信号 ${sig} 中断`)
        return
      }
      const output = [stdout, stderr].filter(Boolean).join('\n')
      if (code !== 0) {
        resolve(`[exit code: ${code}]\n${output || '命令执行失败'}`)
      } else {
        resolve(output || 'OK')
      }
    })

    child.on('error', (err) => {
      if (signal?.aborted) {
        resolve('[已终止] 命令被用户中断')
      } else {
        resolve(`工具执行错误：${err.message}`)
      }
    })
  })
}
