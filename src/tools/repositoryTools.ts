import { execFile } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { parseGitHubRepository, validateGitHubSegment } from './createPullRequest.js'

const execFileAsync = promisify(execFile)

type CommandResult = {
  stdout: string
  stderr: string
}

type GitHubRepositoryInfo = {
  nameWithOwner?: string
  url?: string
  isFork?: boolean
  defaultBranchRef?: { name?: string } | null
  parent?: { nameWithOwner?: string } | null
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
  if (!trimmed || trimmed.toLowerCase() === 'auto' || trimmed === '-') return undefined
  return trimmed
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue
  const normalized = value.trim().toLowerCase()
  if (!normalized || normalized === 'auto' || normalized === '-') return defaultValue
  return ['1', 'true', 'yes', 'y', 'draft'].includes(normalized)
}

function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(`GitHub CLI 返回了无法解析的 JSON: ${raw}`)
  }
}

async function getGitHubLogin(rootDir: string): Promise<string> {
  return (await runGh(rootDir, ['api', 'user', '--jq', '.login'])).trim()
}

async function getGitHubRepositoryInfo(rootDir: string, repoFullName: string): Promise<GitHubRepositoryInfo | null> {
  try {
    const raw = await runGh(rootDir, [
      'repo',
      'view',
      repoFullName,
      '--json',
      'nameWithOwner,url,isFork,parent,defaultBranchRef',
    ])
    return parseJson<GitHubRepositoryInfo>(raw)
  } catch {
    return null
  }
}

function sameRepository(a: string | undefined, b: string): boolean {
  return (a ?? '').toLowerCase() === b.toLowerCase()
}

function buildGitHubRepositoryUrl(repoFullName: string): string {
  return `https://github.com/${repoFullName}`
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

async function waitForGitHubRepository(rootDir: string, repoFullName: string): Promise<GitHubRepositoryInfo> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const info = await getGitHubRepositoryInfo(rootDir, repoFullName)
    if (info) return info
    await sleep(1000)
  }
  throw new Error(`Fork 已请求创建，但暂时无法读取仓库信息: ${repoFullName}`)
}

function validateLocalDirName(value: string, label: string): void {
  if (!/^[^<>:"/\\|?*]+$/.test(value)
    || value === '.'
    || value === '..'
    || value.includes('..')) {
    throw new Error(`${label} 不合法: ${value}`)
  }
}

function validateRemoteName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('-')) {
    throw new Error(`remote 名不合法: ${name}`)
  }
}

function inferRepositoryName(repoUrl: string): string {
  const name = parseGitHubRepository(repoUrl).name
  validateLocalDirName(name, 'cloneDirName')
  return name
}

async function getCurrentBranch(rootDir: string): Promise<string> {
  try {
    return await runGit(rootDir, ['branch', '--show-current'])
  } catch {
    return ''
  }
}

export async function forkRepositoryTool(
  rootDir: string,
  repoUrlArg: string,
  targetOwnerArg: string,
  forkNameArg: string,
  defaultBranchOnlyArg: string,
): Promise<string> {
  const source = parseGitHubRepository(repoUrlArg)
  const explicitTargetOwner = optionalValue(targetOwnerArg)
  const targetOwner = explicitTargetOwner ?? await getGitHubLogin(rootDir)
  const forkName = optionalValue(forkNameArg) ?? source.name
  const defaultBranchOnly = parseBoolean(defaultBranchOnlyArg, false)

  validateGitHubSegment(targetOwner, 'targetOwner')
  validateGitHubSegment(forkName, 'forkName')

  const targetFullName = `${targetOwner}/${forkName}`
  const existingFork = await getGitHubRepositoryInfo(rootDir, targetFullName)
  if (existingFork) {
    const parentFullName = existingFork.parent?.nameWithOwner
    if (!existingFork.isFork || !sameRepository(parentFullName, source.fullName)) {
      throw new Error(`目标仓库已存在但不是 ${source.fullName} 的 fork: ${targetFullName}`)
    }
  } else {
    const forkArgs = ['repo', 'fork', source.fullName, '--clone=false']
    if (explicitTargetOwner) forkArgs.push('--org', targetOwner)
    if (forkName !== source.name) forkArgs.push('--fork-name', forkName)
    if (defaultBranchOnly) forkArgs.push('--default-branch-only')
    await runGh(rootDir, forkArgs)
  }

  const forkInfo = await waitForGitHubRepository(rootDir, targetFullName)
  const forkUrl = forkInfo.url ?? buildGitHubRepositoryUrl(targetFullName)
  const defaultBranch = forkInfo.defaultBranchRef?.name ?? 'main'

  return [
    existingFork ? 'Fork 已存在。' : 'Fork 创建成功。',
    `源仓库: ${source.fullName}`,
    `Fork 仓库: ${targetFullName}`,
    `Fork URL: ${forkUrl}`,
    `默认分支: ${defaultBranch}`,
  ].join('\n')
}

export async function cloneRepositoryTool(
  rootDir: string,
  repoUrlArg: string,
  cloneParentDirArg: string,
  cloneDirNameArg: string,
  remoteNameArg: string,
  upstreamUrlArg: string,
  upstreamRemoteNameArg: string,
): Promise<string> {
  const repoUrl = repoUrlArg.trim()
  if (!repoUrl) throw new Error('repoUrl 不能为空')

  const cloneParentDir = resolve(rootDir, optionalValue(cloneParentDirArg) ?? '.')
  const cloneDirName = optionalValue(cloneDirNameArg) ?? inferRepositoryName(repoUrl)
  const remoteName = optionalValue(remoteNameArg) ?? 'origin'
  const upstreamUrl = optionalValue(upstreamUrlArg)
  const upstreamRemoteName = optionalValue(upstreamRemoteNameArg) ?? 'upstream'

  validateLocalDirName(cloneDirName, 'cloneDirName')
  validateRemoteName(remoteName)
  if (upstreamUrl) validateRemoteName(upstreamRemoteName)

  const cloneDir = resolve(cloneParentDir, cloneDirName)
  const existingCloneDir = await stat(cloneDir).catch(() => null)
  if (existingCloneDir) {
    throw new Error(`本地 clone 目录已存在: ${cloneDir}`)
  }
  await mkdir(cloneParentDir, { recursive: true })

  await runGit(rootDir, ['clone', '--origin', remoteName, repoUrl, cloneDir])
  if (upstreamUrl) {
    await runGit(cloneDir, ['remote', 'add', upstreamRemoteName, upstreamUrl])
  }

  const currentBranch = await getCurrentBranch(cloneDir)
  return [
    'Clone 成功。',
    `仓库地址: ${repoUrl}`,
    `本地目录: ${cloneDir}`,
    `主 remote: ${remoteName}`,
    `当前分支: ${currentBranch || 'unknown'}`,
    upstreamUrl ? `额外 remote: ${upstreamRemoteName} -> ${upstreamUrl}` : '额外 remote: 未配置',
  ].join('\n')
}
