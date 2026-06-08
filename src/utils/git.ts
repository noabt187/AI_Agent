import { runCommand } from './command.js'

// ── 底层调用 ──

/** 执行 git 命令，返回合并后的 stdout+stderr */
export async function runGit(rootDir: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await runCommand('git', args, rootDir)
  return [stdout, stderr].filter(Boolean).join('\n').trim()
}

// ── 仓库状态 ──

/** 当前目录是否是 git 仓库 */
export async function isGitRepo(rootDir: string): Promise<boolean> {
  try {
    await runGit(rootDir, ['rev-parse', '--is-inside-work-tree'])
    return true
  } catch {
    return false
  }
}

/** git status --porcelain（空字符串 = 无改动） */
export async function getStatus(rootDir: string): Promise<string> {
  return await runGit(rootDir, ['status', '--porcelain'])
}

/** 是否有未提交的改动 */
export async function hasChanges(rootDir: string): Promise<boolean> {
  const s = await getStatus(rootDir)
  return s.length > 0
}

// ── 分支 ──

/** 获取当前分支名（不在分支上返回空字符串） */
export async function getCurrentBranch(rootDir: string): Promise<string> {
  try {
    return await runGit(rootDir, ['branch', '--show-current'])
  } catch {
    return ''
  }
}

/** 本地分支是否存在 */
export async function branchExists(rootDir: string, branchName: string): Promise<boolean> {
  try {
    await runGit(rootDir, ['show-ref', '--verify', `refs/heads/${branchName}`])
    return true
  } catch {
    return false
  }
}

/** 创建并切换到新分支 */
export async function createAndCheckout(rootDir: string, branchName: string): Promise<void> {
  await runGit(rootDir, ['checkout', '-b', branchName])
}

/** 切换到已有分支 */
export async function checkout(rootDir: string, branchName: string): Promise<void> {
  await runGit(rootDir, ['checkout', branchName])
}

// ── 远程 ──

/** 远程是否存在 */
export async function remoteExists(rootDir: string, remoteName: string): Promise<boolean> {
  try {
    await runGit(rootDir, ['remote', 'get-url', remoteName])
    return true
  } catch {
    return false
  }
}

/** 获取远程 URL（不存在返回 null） */
export async function getRemoteUrl(rootDir: string, remoteName: string): Promise<string | null> {
  try {
    return await runGit(rootDir, ['remote', 'get-url', remoteName])
  } catch {
    return null
  }
}

/** 添加远程 */
export async function addRemote(rootDir: string, remoteName: string, url: string): Promise<void> {
  await runGit(rootDir, ['remote', 'add', remoteName, url])
}

/** 设置远程 URL */
export async function setRemoteUrl(rootDir: string, remoteName: string, url: string): Promise<void> {
  await runGit(rootDir, ['remote', 'set-url', remoteName, url])
}

/** 添加或设置远程：存在则 set-url，不存在则 add */
export async function addOrSetRemote(rootDir: string, remoteName: string, url: string): Promise<void> {
  if (await remoteExists(rootDir, remoteName)) {
    await setRemoteUrl(rootDir, remoteName, url)
  } else {
    await addRemote(rootDir, remoteName, url)
  }
}

// ── 暂存 & 提交 & 推送 ──

/** git add -A */
export async function addAll(rootDir: string): Promise<void> {
  await runGit(rootDir, ['add', '-A'])
}

/** git commit */
export async function commit(rootDir: string, message: string): Promise<void> {
  await runGit(rootDir, ['commit', '-m', message])
}

/** git push -u remote branch */
export async function pushUpstream(rootDir: string, remote: string, branch: string): Promise<void> {
  await runGit(rootDir, ['push', '-u', remote, branch])
}

// ── Clone ──

/** git clone */
export async function clone(
  rootDir: string,
  url: string,
  targetDir: string,
  remoteName = 'origin',
): Promise<void> {
  await runGit(rootDir, ['clone', '--origin', remoteName, url, targetDir])
}

// ── 信息查询 ──

/** 获取某个提交的 diff 统计 */
export async function getDiffStat(rootDir: string, ref = 'HEAD'): Promise<string> {
  return await runGit(rootDir, ['show', '--stat', '--oneline', '--no-renames', ref])
}

/** 获取所有远程列表 */
export async function getRemotes(rootDir: string): Promise<string[]> {
  const out = await runGit(rootDir, ['remote'])
  return out ? out.split('\n').filter(Boolean) : []
}

// ── 校验 ──

/** 校验分支/标签名是否合法 */
export function validateRefName(name: string, label: string): void {
  if (
    !/^[A-Za-z0-9._/-]+$/.test(name) ||
    name.startsWith('-') ||
    name.includes('..') ||
    name.includes('//') ||
    name.endsWith('/') ||
    name.endsWith('.')
  ) {
    throw new Error(`${label} 不合法: ${name}`)
  }
}

/** 校验 remote 名是否合法 */
export function validateRemoteName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('-')) {
    throw new Error(`remote 名不合法: ${name}`)
  }
}

/** 校验本地目录名是否合法 */
export function validateLocalDirName(value: string, label: string): void {
  if (
    !/^[^<>:"/\\|?*]+$/.test(value) ||
    value === '.' ||
    value === '..' ||
    value.includes('..')
  ) {
    throw new Error(`${label} 不合法: ${value}`)
  }
}

// ── 工具 ──

/** 生成时间戳分支名 agent/pr-YYYYMMDD-HHmmss */
export function timestampBranch(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `agent/pr-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
