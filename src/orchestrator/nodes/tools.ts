import { readdir, stat, readFile, writeFile as fsWriteFile, unlink, mkdir } from 'node:fs/promises'
import { resolve, relative, extname, sep, dirname } from 'node:path'
import { exec, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readTextFile } from '../../tools/fileTools.js'

import type { ToolDefinition } from '../../llm/types.js'

type ToolScope = 'read' | 'write'

// ── Tool Definitions ────────────────────────────────────────────────

type ToolFn = (rootDir: string, ...args: string[]) => Promise<string>

type ToolDef = {
  fn: ToolFn
  description: string
  argNames: string[]
  scope: ToolScope
}

const execFileAsync = promisify(execFile)

async function listDirectory(rootDir: string, dirPath: string): Promise<string> {
  const fullPath = resolve(rootDir, dirPath)
  const entries = await readdir(fullPath)
  const lines: string[] = []
  for (const entry of entries.sort()) {
    const entryPath = resolve(fullPath, entry)
    const s = await stat(entryPath)
    lines.push(s.isDirectory() ? `${entry}/` : entry)
  }
  return lines.join('\n')
}

async function searchFiles(rootDir: string, pattern: string): Promise<string> {
  const allFiles = await collectFiles(rootDir)
  const regex = patternToRegex(pattern)
  const matched = allFiles.filter((f) => regex.test(f))
  if (matched.length === 0) return '没有找到匹配的文件'
  return matched.join('\n')
}

async function searchContent(rootDir: string, keyword: string): Promise<string> {
  const allFiles = await collectFiles(rootDir)
  const results: string[] = []
  const lowerKw = keyword.toLowerCase()

  for (const relPath of allFiles) {
    try {
      const content = await readFile(resolve(rootDir, relPath), 'utf8')
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(lowerKw)) {
          results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`)
          if (results.length >= 50) return results.join('\n')
        }
      }
    } catch {}
  }

  return results.length > 0 ? results.join('\n') : '没有找到匹配的内容'
}

async function writeFileTool(rootDir: string, relativePath: string, content: string): Promise<string> {
  const fullPath = resolve(rootDir, relativePath)
  await mkdir(dirname(fullPath), { recursive: true })
  await fsWriteFile(fullPath, content, 'utf8')
  return `已写入: ${relativePath}`
}

async function deleteFileTool(rootDir: string, relativePath: string): Promise<string> {
  const fullPath = resolve(rootDir, relativePath)
  await unlink(fullPath)
  return `已删除: ${relativePath}`
}

// ── File Collection ─────────────────────────────────────────────────

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'state'])
const SUPPORTED_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.html', '.css', '.json', '.md', '.vue', '.svelte'])

async function collectFiles(dir: string, prefix = ''): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const results: string[] = []
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry)) continue
    const fullPath = resolve(dir, entry)
    let s: Awaited<ReturnType<typeof stat>>
    try {
      s = await stat(fullPath)
    } catch {
      continue
    }
    const rel = prefix ? `${prefix}/${entry}` : entry
    if (s.isDirectory()) {
      results.push(...(await collectFiles(fullPath, rel)))
    } else {
      const ext = extname(entry)
      if (SUPPORTED_EXT.has(ext)) {
        results.push(rel)
      }
    }
  }
  return results
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

async function execCommandTool(rootDir: string, command: string): Promise<string> {
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

async function verifyCodeTool(rootDir: string, changedFiles: string): Promise<string> {
  const results: string[] = []
  let hasError = false

  // ── 1. 读取 package.json，检测可用命令 ──
  const scripts: Record<string, string> = {}
  try {
    const pkgRaw = await readFile(resolve(rootDir, 'package.json'), 'utf8')
    const pkg = JSON.parse(pkgRaw)
    Object.assign(scripts, pkg.scripts || {})
  } catch {}

  // 检查是否有子项目的 package.json（前后端分离项目）
  const subDirs = ['backend', 'frontend']
  const subScripts: Record<string, Record<string, string>> = {}
  for (const sub of subDirs) {
    try {
      const subPkgRaw = await readFile(resolve(rootDir, sub, 'package.json'), 'utf8')
      const subPkg = JSON.parse(subPkgRaw)
      subScripts[sub] = subPkg.scripts || {}
    } catch {}
  }

  // ── 2. 运行可用的验证命令 ──
  const runCmd = (cmd: string, cwd: string): Promise<{ ok: boolean; output: string }> => {
    return new Promise((r) => {
      exec(cmd, { cwd, timeout: 60000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join('\n')
        r({ ok: !err, output: output.slice(0, 2000) })
      })
    })
  }

  // 根目录 test
  if (scripts.test) {
    const { ok, output } = await runCmd('npm test -- --run', rootDir)
    if (!ok) {
      hasError = true
      results.push(`❌ 根目录 npm test 失败:\n${output}`)
    } else {
      results.push(`✅ 根目录 npm test 通过`)
    }
  }

  // 子项目 lint/test/build
  for (const [dir, sc] of Object.entries(subScripts)) {
    if (sc.lint) {
      const { ok, output } = await runCmd('npm run lint', resolve(rootDir, dir))
      if (!ok) {
        hasError = true
        results.push(`❌ ${dir}/npm run lint 失败:\n${output}`)
      } else {
        results.push(`✅ ${dir}/npm run lint 通过`)
      }
    }
    if (sc.test) {
      const { ok, output } = await runCmd('npm test', resolve(rootDir, dir))
      if (!ok) {
        hasError = true
        results.push(`❌ ${dir}/npm test 失败:\n${output}`)
      } else {
        results.push(`✅ ${dir}/npm test 通过`)
      }
    }
    if (sc.build) {
      const { ok, output } = await runCmd('npm run build', resolve(rootDir, dir))
      if (!ok) {
        hasError = true
        results.push(`❌ ${dir}/npm run build 失败:\n${output}`)
      } else {
        results.push(`✅ ${dir}/npm run build 通过`)
      }
    }
  }

  // ── 3. 跨栈一致性检查 ──
  const files = changedFiles.split(',').map((f) => f.trim()).filter(Boolean)
  const backendModelFiles = files.filter((f) => /models?\//i.test(f) && /backend/i.test(f))
  const backendControllerFiles = files.filter((f) => /controllers?\//i.test(f) && /backend/i.test(f))

  if (backendModelFiles.length > 0 || backendControllerFiles.length > 0) {
    // 读取后端模型文件，提取字段名
    const backendFields: string[] = []
    for (const modelFile of backendModelFiles) {
      try {
        const content = await readFile(resolve(rootDir, modelFile), 'utf8')
        // 提取 DataTypes 定义的字段名（简单正则）
        const fieldMatches = content.matchAll(/^\s+(\w+)\s*:/gm)
        for (const m of fieldMatches) {
          const field = m[1]
          if (['id', 'createdAt', 'updatedAt', 'associate', 'toJSON', 'init', 'type', 'defaultValue', 'allowNull', 'primaryKey', 'autoIncrement', 'unique'].includes(field)) continue
          if (field.startsWith('_')) continue
          backendFields.push(field)
        }
      } catch {}
    }

    // 检查前端是否引用了这些字段
    if (backendFields.length > 0) {
      const frontendDir = resolve(rootDir, 'frontend', 'src')
      for (const field of backendFields) {
        try {
          const allFrontendFiles = await collectFiles(frontendDir)
          let found = false
          for (const f of allFrontendFiles) {
            try {
              const content = await readFile(resolve(frontendDir, f), 'utf8')
              if (content.includes(field)) {
                found = true
                break
              }
            } catch {}
          }
          if (!found) {
            results.push(`⚠️ 跨栈一致性: 后端字段 "${field}" 在前端代码中未找到引用，可能需要同步修改前端`)
          }
        } catch {}
      }
      if (backendFields.length > 0 && !results.some((r) => r.includes('⚠️'))) {
        results.push(`✅ 跨栈一致性检查通过（后端字段: ${backendFields.join(', ')}）`)
      }
    }
  }

  if (backendModelFiles.length === 0 && backendControllerFiles.length === 0) {
    results.push(`ℹ️ 本次修改未涉及后端模型/控制器，跳过跨栈一致性检查`)
  }

  // ── 4. 汇总 ──
  const summary = hasError ? '❌ 验证未通过' : '✅ 验证通过'
  return `${summary}\n\n${results.join('\n')}`
}

type CommandResult = {
  stdout: string
  stderr: string
}

async function runCommand(file: string, args: string[], cwd: string): Promise<CommandResult> {
  const result = await execFileAsync(file, args, {
    cwd,
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

async function runGit(rootDir: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await runCommand('git', args, rootDir)
  return [stdout, stderr].filter(Boolean).join('\n').trim()
}

async function runGh(rootDir: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await runCommand('gh', args, rootDir)
  return [stdout, stderr].filter(Boolean).join('\n').trim()
}

function optionalValue(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed || trimmed === 'auto' || trimmed === '-') return undefined
  return trimmed
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue
  const normalized = value.trim().toLowerCase()
  if (!normalized || normalized === 'auto' || normalized === '-') return defaultValue
  return ['1', 'true', 'yes', 'y', 'draft'].includes(normalized)
}

function timestampBranch(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `agent/pr-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function validateRefName(name: string, label: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(name)
    || name.startsWith('-')
    || name.includes('..')
    || name.includes('//')
    || name.endsWith('/')
    || name.endsWith('.')) {
    throw new Error(`${label} 不合法: ${name}`)
  }
}

function validateRemoteName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('-')) {
    throw new Error(`remote 名不合法: ${name}`)
  }
}

function toGhRepo(repoUrl: string): string {
  const trimmed = repoUrl.trim().replace(/\.git$/, '')
  const sshMatch = trimmed.match(/^git@([^:]+):(.+)$/)
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`
  }

  try {
    const url = new URL(trimmed)
    const path = url.pathname.replace(/^\/+/, '')
    if (url.hostname === 'github.com') return path
    return `${url.hostname}/${path}`
  } catch {}

  return trimmed
}

function githubCliSetupMessage(reason: string): string {
  return [
    `错误：${reason}`,
    '',
    'createPullRequest 需要本机安装并登录 GitHub CLI（gh），因为创建 PR 依赖 gh pr create。',
    '',
    'Windows PowerShell:',
    '  winget install --id GitHub.cli',
    '  gh auth login',
    '  gh auth status',
    '',
    'macOS:',
    '  brew install gh',
    '  gh auth login',
    '  gh auth status',
    '',
    'Linux:',
    '  请参考 https://github.com/cli/cli/blob/trunk/docs/install_linux.md 安装 gh',
    '  gh auth login',
    '  gh auth status',
  ].join('\n')
}

async function checkGitHubCliReady(rootDir: string): Promise<string | null> {
  try {
    await runGh(rootDir, ['--version'])
  } catch {
    return githubCliSetupMessage('未检测到 GitHub CLI（gh）')
  }

  try {
    await runGh(rootDir, ['auth', 'status'])
  } catch {
    return githubCliSetupMessage('GitHub CLI 尚未登录或 token 权限不足')
  }

  return null
}

async function remoteExists(rootDir: string, remoteName: string): Promise<boolean> {
  try {
    await runGit(rootDir, ['remote', 'get-url', remoteName])
    return true
  } catch {
    return false
  }
}

async function getCurrentBranch(rootDir: string): Promise<string> {
  try {
    return await runGit(rootDir, ['branch', '--show-current'])
  } catch {
    return ''
  }
}

async function createPullRequestTool(
  rootDir: string,
  repoUrlArg: string,
  titleArg: string,
  bodyArg: string,
  baseBranchArg: string,
  headBranchArg: string,
  commitMessageArg: string,
  draftArg: string,
  remoteArg: string,
): Promise<string> {
  await runGit(rootDir, ['rev-parse', '--is-inside-work-tree'])

  const status = await runGit(rootDir, ['status', '--porcelain'])
  if (!status.trim()) {
    return '没有检测到本地改动，未创建 PR。'
  }

  const remoteName = optionalValue(remoteArg) ?? 'origin'
  const baseBranch = optionalValue(baseBranchArg) ?? 'main'
  const headBranch = optionalValue(headBranchArg) ?? timestampBranch()
  const title = optionalValue(titleArg) ?? 'Agent changes'
  const commitMessage = optionalValue(commitMessageArg) ?? title
  const draft = parseBoolean(draftArg, true)
  const bodyFromUser = optionalValue(bodyArg)

  validateRemoteName(remoteName)
  validateRefName(baseBranch, 'baseBranch')
  validateRefName(headBranch, 'headBranch')

  const explicitRepoUrl = optionalValue(repoUrlArg)
  let repoUrl = explicitRepoUrl
  const hasRemote = await remoteExists(rootDir, remoteName)

  if (repoUrl) {
    if (hasRemote) {
      await runGit(rootDir, ['remote', 'set-url', remoteName, repoUrl])
    } else {
      await runGit(rootDir, ['remote', 'add', remoteName, repoUrl])
    }
  } else if (hasRemote) {
    repoUrl = await runGit(rootDir, ['remote', 'get-url', remoteName])
  } else {
    return `错误：无法推断远程仓库。请让用户提供 repoUrl，或先在项目中配置 git remote "${remoteName}"。`
  }

  const ghReadyError = await checkGitHubCliReady(rootDir)
  if (ghReadyError) return ghReadyError

  const currentBranch = await getCurrentBranch(rootDir)
  if (currentBranch !== headBranch) {
    try {
      await runGit(rootDir, ['show-ref', '--verify', `refs/heads/${headBranch}`])
      return `错误：本地分支 "${headBranch}" 已存在。请换一个 headBranch，或先切到该分支后重试。`
    } catch {
      await runGit(rootDir, ['checkout', '-b', headBranch])
    }
  }

  await runGit(rootDir, ['add', '-A'])
  await runGit(rootDir, ['commit', '-m', commitMessage])

  const diffStat = await runGit(rootDir, ['show', '--stat', '--oneline', '--no-renames', 'HEAD'])
  await runGit(rootDir, ['push', '-u', remoteName, headBranch])

  const body = bodyFromUser ?? [
    'Agent 自动提交的变更。',
    '',
    '```',
    diffStat,
    '```',
  ].join('\n')

  const prArgs = [
    'pr',
    'create',
    '--repo',
    toGhRepo(repoUrl),
    '--base',
    baseBranch,
    '--head',
    headBranch,
    '--title',
    title,
    '--body',
    body,
  ]
  if (draft) prArgs.push('--draft')

  const prOutput = await runGh(rootDir, prArgs)

  return [
    'PR 创建成功。',
    `远程仓库: ${repoUrl}`,
    `base: ${baseBranch}`,
    `head: ${headBranch}`,
    `draft: ${draft ? 'true' : 'false'}`,
    '',
    prOutput,
  ].join('\n')
}

// ── Registry ────────────────────────────────────────────────────────

const toolRegistry: Record<string, ToolDef> = {
  readTextFile: {
    fn: readTextFile,
    description: '读取指定路径的文本文件内容',
    argNames: ['rootDir', 'relativePath'],
    scope: 'read',
  },
  listDirectory: {
    fn: listDirectory,
    description: '列出指定目录下的文件和文件夹',
    argNames: ['rootDir', 'dirPath'],
    scope: 'read',
  },
  searchFiles: {
    fn: searchFiles,
    description: '按文件名模式搜索文件（支持 * 通配符）',
    argNames: ['rootDir', 'pattern'],
    scope: 'read',
  },
  searchContent: {
    fn: searchContent,
    description: '按关键词搜索代码内容，返回匹配的文件名、行号和内容',
    argNames: ['rootDir', 'keyword'],
    scope: 'read',
  },
  writeFile: {
    fn: writeFileTool,
    description: '创建或覆盖写入文件（自动创建父目录）',
    argNames: ['rootDir', 'relativePath', 'content'],
    scope: 'write',
  },
  deleteFile: {
    fn: deleteFileTool,
    description: '删除指定文件（需要人工确认）',
    argNames: ['rootDir', 'relativePath'],
    scope: 'write',
  },
  execCommand: {
    fn: execCommandTool,
    description: '在项目目录下执行 shell 命令，用于运行 lint、test、build 等',
    argNames: ['rootDir', 'command'],
    scope: 'read',
  },
  verifyCode: {
    fn: verifyCodeTool,
    description: '验证代码质量：运行 lint/test/build + 跨栈一致性检查，changedFiles 为本次修改的文件列表（逗号分隔）',
    argNames: ['rootDir', 'changedFiles'],
    scope: 'read',
  },
  createPullRequest: {
    fn: createPullRequestTool,
    description: '把当前项目的本地改动提交到新分支并创建 GitHub PR。repoUrl 可传 auto 或空字符串自动读取 git remote；draft 默认 true。参数: repoUrl,title,body,baseBranch,headBranch,commitMessage,draft,remote',
    argNames: ['rootDir', 'repoUrl', 'title', 'body', 'baseBranch', 'headBranch', 'commitMessage', 'draft', 'remote'],
    scope: 'write',
  },
}

// ── Tool Descriptions ───────────────────────────────────────────────

export function getToolDescriptionsForScope(scope: ToolScope): string {
  return Object.entries(toolRegistry)
    .filter(([, def]) => scope === 'write' || def.scope === 'read')
    .map(([name, def]) => {
      const args = def.argNames.map((a) => `${a}: string`).join(', ')
      return `- ${name}(${args}): ${def.description}`
    })
    .join('\n')
}

// ── OpenAI Tool Definitions ───────────────────────────────────────────

export function toolDefsToOpenAI(scope: ToolScope): ToolDefinition[] {
  return Object.entries(toolRegistry)
    .filter(([, def]) => scope === 'write' || def.scope === 'read')
    .map(([name, def]) => {
      const properties: Record<string, { type: string; description: string }> = {}
      for (const arg of def.argNames) {
        properties[arg] = {
          type: 'string',
          description: arg === 'rootDir'
            ? '项目根目录'
            : (name === 'createPullRequest' && arg !== 'repoUrl' ? `${arg}，可传 auto 使用默认值` : arg),
        }
      }
      const required = name === 'createPullRequest' ? ['rootDir'] : def.argNames
      return {
        type: 'function' as const,
        function: {
          name,
          description: def.description,
          parameters: {
            type: 'object' as const,
            properties,
            required,
          },
        },
      }
    })
}

// ── Path Validation ─────────────────────────────────────────────────

function assertInsideRoot(rootDir: string, targetPath: string): void {
  const resolvedRoot = resolve(rootDir)
  const resolvedTarget = resolve(rootDir, targetPath)
  const rel = relative(resolvedRoot, resolvedTarget)
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`路径越界："${targetPath}" 超出了项目根目录`)
  }
}

function assertInsideAllowedPaths(targetPath: string, allowedPaths: string[]): void {
  const resolvedTarget = resolve(targetPath)
  for (const allowed of allowedPaths) {
    const resolvedAllowed = resolve(allowed)
    const rel = relative(resolvedAllowed, resolvedTarget)
    if (!rel.startsWith('..') && rel !== '..') {
      return // inside this allowed path
    }
  }
  throw new Error(`路径越界："${targetPath}" 不在允许的操作目录内`)
}

function isNonPathToolArg(toolName: string, argName: string): boolean {
  if (toolName === 'execCommand' && argName === 'command') return true
  if (toolName === 'verifyCode' && argName === 'changedFiles') return true
  if (toolName === 'createPullRequest') return true
  return false
}

// ── Execute Tool ────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  args: Record<string, string>,
  allowedPaths?: string[],
  scope: ToolScope = 'read',
): Promise<string> {
  const tool = toolRegistry[name]
  if (!tool) return `错误：未知工具 "${name}"`
  if (scope === 'read' && tool.scope !== 'read') {
    return `错误：工具 "${name}" 不在当前节点的可用范围内（只读模式）`
  }
  try {
    const rootDir = args.rootDir ?? '.'
    if (tool.scope === 'write' && allowedPaths) {
      assertInsideAllowedPaths(rootDir, allowedPaths)
    }
    for (const argName of tool.argNames) {
      if (argName === 'rootDir') continue
      const val = args[argName]

      // listDirectory with empty dirPath = list root directory
      if (name === 'listDirectory' && argName === 'dirPath' && (!val || val.trim() === '')) {
        args[argName] = '.' // default to root
        continue
      }

      // searchFiles with empty pattern = match all (use *)
      if (name === 'searchFiles' && argName === 'pattern' && (!val || val.trim() === '')) {
        return `错误：工具 "${name}" 缺少搜索模式（pattern 不能为空）`
      }

      // createPullRequest has optional metadata fields. Empty values mean "use defaults".
      if (name === 'createPullRequest') {
        continue
      }

      // Some arguments are commands or metadata, not filesystem paths.
      if (isNonPathToolArg(name, argName)) {
        if (!val || val.trim() === '') {
          return `错误：工具 "${name}" 缺少必需参数 "${argName}"`
        }
        continue
      }

      // All other params are required
      if (!val || val.trim() === '') {
        return `错误：工具 "${name}" 缺少必需参数 "${argName}"`
      }
      assertInsideRoot(rootDir, val)
    }

    // For write-scope tools, validate against allowedPaths
    if (tool.scope === 'write' && allowedPaths) {
      for (const argName of tool.argNames) {
        if (argName !== 'rootDir' && argName !== 'content' && args[argName] && !isNonPathToolArg(name, argName)) {
          const fullPath = resolve(rootDir, args[argName])
          assertInsideAllowedPaths(fullPath, allowedPaths)
        }
      }
    }

    const argValues = tool.argNames.map((n) => args[n] ?? '')
    return await tool.fn(rootDir, ...argValues.slice(1))
  } catch (e: unknown) {
    return `工具执行错误：${e instanceof Error ? e.message : String(e)}`
  }
}
