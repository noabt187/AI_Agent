import { exec } from 'node:child_process'

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

export async function execCommandTool(rootDir: string, command: string): Promise<string> {
  if (!isCommandAllowed(command)) {
    return `错误：命令 "${command}" 不在白名单中。允许的命令：npm test, npm run build, npm run lint, npm run format 等验证类命令。`
  }
  return new Promise((resolve) => {
    exec(command, { cwd: rootDir, timeout: 60000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join('\n')
      if (err) {
        resolve(`[exit code: ${err.code}]\n${output || err.message}`)
      } else {
        resolve(output || 'OK')
      }
    })
  })
}
