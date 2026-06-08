import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runCommand } from './command.js'

// ── 底层调用 ──

let cachedGhCmd: string | null = null

/** 搜索 gh.exe 的完整路径（Windows + Unix 通用） */
export async function resolveGhCommand(): Promise<string> {
  if (cachedGhCmd) return cachedGhCmd

  // 1. 先试 PATH 里的 gh
  try {
    await runCommand('gh', ['--version'], process.cwd())
    cachedGhCmd = 'gh'
    return cachedGhCmd
  } catch {}

  // 2. Windows 常见安装路径
  const candidates: string[] = []

  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\GitHub CLI\\gh.exe',
      'C:\\Program Files (x86)\\GitHub CLI\\gh.exe',
      join(homedir(), 'bin', 'gh.exe'),
      join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'GitHub CLI', 'gh.exe'),
    )
  } else {
    // Linux / macOS
    candidates.push(
      '/usr/local/bin/gh',
      '/usr/bin/gh',
      join(homedir(), '.local', 'bin', 'gh'),
    )
  }

  for (const candidate of candidates) {
    try {
      await access(candidate)
      cachedGhCmd = candidate
      return cachedGhCmd
    } catch {}
  }

  // 3. 都找不到，返回 'gh' 让后续报友好错误
  cachedGhCmd = 'gh'
  return cachedGhCmd
}

/**
 * 执行 gh 命令
 * 内部自动调用 resolveGhCommand() 找到 gh 可执行文件路径
 */
export async function runGh(rootDir: string, args: string[]): Promise<string> {
  const ghCmd = await resolveGhCommand()
  const { stdout, stderr } = await runCommand(ghCmd, args, rootDir)
  return [stdout, stderr].filter(Boolean).join('\n').trim()
}

// ── 登录 & 就绪检查 ──

/** 检查 gh 是否安装并已登录。返回 null 表示就绪，否则返回错误提示文案 */
export async function checkGhReady(rootDir: string): Promise<string | null> {
  try {
    await runGh(rootDir, ['--version'])
  } catch {
    return ghSetupHelp('未检测到 GitHub CLI（gh）')
  }

  try {
    await runGh(rootDir, ['auth', 'status'])
  } catch {
    return ghSetupHelp('GitHub CLI 尚未登录或 token 权限不足')
  }

  return null
}

/** 获取当前登录的 GitHub 账号名 */
export async function getGhLogin(rootDir: string): Promise<string> {
  return (await runGh(rootDir, ['api', 'user', '--jq', '.login'])).trim()
}

// ── 仓库信息 ──

export type RepoInfo = {
  nameWithOwner?: string
  url?: string
  isFork?: boolean
  defaultBranchRef?: { name?: string } | null
  parent?: { nameWithOwner?: string } | null
}

function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(`GitHub CLI 返回了无法解析的 JSON: ${raw}`)
  }
}

/** 查询 GitHub 仓库信息（不存在返回 null） */
export async function getRepoInfo(rootDir: string, repoFullName: string): Promise<RepoInfo | null> {
  try {
    const raw = await runGh(rootDir, [
      'repo', 'view', repoFullName,
      '--json', 'nameWithOwner,url,isFork,parent,defaultBranchRef',
    ])
    return parseJson<RepoInfo>(raw)
  } catch {
    return null
  }
}

/** fork 后轮询等待仓库就绪（最多 5 次，间隔 1s） */
export async function waitForRepo(rootDir: string, repoFullName: string): Promise<RepoInfo> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const info = await getRepoInfo(rootDir, repoFullName)
    if (info) return info
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`Fork 已请求创建，但暂时无法读取仓库信息: ${repoFullName}`)
}

// ── Fork ──

export type ForkOptions = {
  /** fork 到的目标组织（不传则 fork 到当前登录账号） */
  targetOrg?: string
  /** fork 后的仓库名（不传则同源仓库名） */
  forkName?: string
  /** 是否只 fork 默认分支 */
  defaultBranchOnly?: boolean
}

/** Fork 一个 GitHub 仓库（不 clone 到本地） */
export async function forkRepo(
  rootDir: string,
  sourceFullName: string,
  opts: ForkOptions = {},
): Promise<void> {
  const args = ['repo', 'fork', sourceFullName, '--clone=false']
  if (opts.targetOrg) args.push('--org', opts.targetOrg)
  if (opts.forkName && opts.forkName !== sourceFullName.split('/')[1]) {
    args.push('--fork-name', opts.forkName)
  }
  if (opts.defaultBranchOnly) args.push('--default-branch-only')
  await runGh(rootDir, args)
}

// ── PR 创建 ──

export type CreatePROptions = {
  repo: string       // 目标仓库 fullName，如 "owner/repo"
  base: string       // base 分支
  head: string       // head 分支，格式 "owner:branch"
  title: string
  body: string
  draft?: boolean
}

/** 创建 GitHub PR，返回 gh 命令的原始输出（含 PR URL） */
export async function createPR(rootDir: string, opts: CreatePROptions): Promise<string> {
  const args = [
    'pr', 'create',
    '--repo', opts.repo,
    '--base', opts.base,
    '--head', opts.head,
    '--title', opts.title,
    '--body', opts.body,
  ]
  if (opts.draft) args.push('--draft')
  return await runGh(rootDir, args)
}

// ── URL 解析 & 校验 ──

export type RepoRef = {
  owner: string
  name: string
  fullName: string
}

/**
 * 解析 GitHub 仓库地址
 * 支持: https://github.com/owner/name, git@github.com:owner/name, owner/name
 */
export function parseRepoUrl(repoUrl: string): RepoRef {
  const trimmed = repoUrl.trim().replace(/\.git$/, '')

  // SSH: git@github.com:owner/name
  const sshMatch = trimmed.match(/^git@([^:]+):(.+)$/)
  if (sshMatch) {
    const [owner, name] = sshMatch[2].split('/')
    if (!owner || !name) throw new Error(`GitHub 仓库地址不合法: ${repoUrl}`)
    validateGhSegment(owner, 'owner')
    validateGhSegment(name, 'repository')
    return { owner, name, fullName: `${owner}/${name}` }
  }

  // HTTPS: https://github.com/owner/name
  try {
    const url = new URL(trimmed)
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
    const startIdx = parts[0]?.includes('.') ? 1 : 0
    const owner = parts[startIdx]
    const name = parts[startIdx + 1]
    if (!owner || !name) throw new Error(`GitHub 仓库地址不合法: ${repoUrl}`)
    validateGhSegment(owner, 'owner')
    validateGhSegment(name, 'repository')
    return { owner, name, fullName: `${owner}/${name}` }
  } catch {
    if (repoUrl.includes('/') && !repoUrl.includes('://')) {
      // 纯 owner/name 格式
      const parts = trimmed.split('/').filter(Boolean)
      if (parts.length >= 2) {
        // 跳过可能的域名前缀
        const startIdx = parts[0]?.includes('.') ? 1 : 0
        const owner = parts[startIdx]
        const name = parts[startIdx + 1]
        if (owner && name) {
          validateGhSegment(owner, 'owner')
          validateGhSegment(name, 'repository')
          return { owner, name, fullName: `${owner}/${name}` }
        }
      }
    }
    throw new Error(`GitHub 仓库地址不合法: ${repoUrl}`)
  }
}

/** 从仓库 fullName 拼出完整的 HTTPS URL */
export function buildRepoUrl(fullName: string): string {
  return `https://github.com/${fullName}`
}

/** 从仓库 URL 推断仓库名 */
export function inferRepoName(repoUrl: string): string {
  return parseRepoUrl(repoUrl).name
}

/** 校验 GitHub owner / repo 名是否合法 */
export function validateGhSegment(value: string, label: string): void {
  if (
    !/^[A-Za-z0-9._-]+$/.test(value) ||
    value.startsWith('-') ||
    value.endsWith('-') ||
    value.includes('..')
  ) {
    throw new Error(`${label} 不合法: ${value}`)
  }
}

/** 判断两个仓库 fullName 是否相同（大小写不敏感） */
export function sameRepo(a: string | undefined, b: string): boolean {
  return (a ?? '').toLowerCase() === b.toLowerCase()
}

// ── 工具 ──

/** 空字符串 / "auto" / "-" → undefined，否则返回原值 */
export function optionalValue(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed || trimmed.toLowerCase() === 'auto' || trimmed === '-') return undefined
  return trimmed
}

/** 解析布尔参数：空/"auto"/"-" → defaultValue，否则按 true/yes/1 判断 */
export function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue
  const normalized = value.trim().toLowerCase()
  if (!normalized || normalized === 'auto' || normalized === '-') return defaultValue
  return ['1', 'true', 'yes', 'y', 'draft'].includes(normalized)
}

// ── 帮助信息 ──

/** gh 未安装或未登录时的友好提示 */
export function ghSetupHelp(reason: string): string {
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
