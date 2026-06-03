import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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

const WINDOWS_GH_PATHS = [
  'C:\\Program Files\\GitHub CLI\\gh.exe',
  'C:\\Program Files (x86)\\GitHub CLI\\gh.exe',
]

let cachedGhCommand: string | null = null

async function resolveGhCommand(): Promise<string> {
  if (cachedGhCommand) return cachedGhCommand

  try {
    await runCommand('gh', ['--version'], process.cwd())
    cachedGhCommand = 'gh'
    return cachedGhCommand
  } catch {}

  for (const candidate of WINDOWS_GH_PATHS) {
    try {
      await access(candidate)
      cachedGhCommand = candidate
      return cachedGhCommand
    } catch {}
  }

  return 'gh'
}

async function runGh(rootDir: string, args: string[]): Promise<string> {
  const ghCommand = await resolveGhCommand()
  const { stdout, stderr } = await runCommand(ghCommand, args, rootDir)
  return [stdout, stderr].filter(Boolean).join('\n').trim()
}

function isDefaultValueToken(value: string | undefined): boolean {
  const trimmed = value?.trim().toLowerCase() ?? ''
  return !trimmed || trimmed === 'auto' || trimmed === '-'
}

function optionalValue(value: string): string | undefined {
  const trimmed = value.trim()
  if (isDefaultValueToken(trimmed)) return undefined
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

export type GitHubRepositoryRef = {
  owner: string
  name: string
  fullName: string
}

export function parseGitHubRepository(repoUrl: string): GitHubRepositoryRef {
  const repo = toGhRepo(repoUrl).replace(/\.git$/, '').replace(/^\/+|\/+$/g, '')
  const parts = repo.split('/').filter(Boolean)
  const startIndex = parts[0]?.includes('.') ? 1 : 0
  const owner = parts[startIndex]
  const name = parts[startIndex + 1]

  if (!owner || !name || parts.length < startIndex + 2) {
    throw new Error(`GitHub 仓库地址不合法: ${repoUrl}`)
  }

  validateGitHubSegment(owner, 'owner')
  validateGitHubSegment(name, 'repository')

  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
  }
}

export function validateGitHubSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value)
    || value.startsWith('-')
    || value.endsWith('-')
    || value.includes('..')) {
    throw new Error(`${label} 不合法: ${value}`)
  }
}

function githubCliSetupMessage(reason: string): string {
  return [
    `错误：${reason}`,
    '',
    'GitHub 仓库操作需要本机安装并登录 GitHub CLI（gh）。',
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
  prRepoUrlArg: string,
  headOwnerArg: string,
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

  const pushRepo = parseGitHubRepository(repoUrl)
  const explicitPrRepoUrl = optionalValue(prRepoUrlArg)
  const prRepoUrl = explicitPrRepoUrl ?? repoUrl
  const prRepo = parseGitHubRepository(prRepoUrl)
  const headOwner = optionalValue(headOwnerArg) ?? pushRepo.owner

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
    prRepo.fullName,
    '--base',
    baseBranch,
    '--head',
    `${headOwner}:${headBranch}`,
    '--title',
    title,
    '--body',
    body,
  ]
  if (draft) prArgs.push('--draft')

  const prOutput = await runGh(rootDir, prArgs)

  return [
    'PR 创建成功。',
    `推送仓库: ${pushRepo.fullName}`,
    `PR 目标仓库: ${prRepo.fullName}`,
    `base: ${baseBranch}`,
    `head: ${headOwner}:${headBranch}`,
    `draft: ${draft ? 'true' : 'false'}`,
    '',
    prOutput,
  ].join('\n')
}

export { createPullRequestTool }
