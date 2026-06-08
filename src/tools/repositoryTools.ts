import { mkdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  runGit,
  getCurrentBranch,
  validateRemoteName,
  validateLocalDirName,
} from '../utils/git.js'
import {
  runGh,
  getGhLogin,
  getRepoInfo,
  waitForRepo,
  forkRepo,
  parseRepoUrl,
  buildRepoUrl,
  validateGhSegment,
  sameRepo,
  inferRepoName,
  optionalValue,
  parseBoolean,
} from '../utils/gh.js'

// ── Fork ──

export async function forkRepositoryTool(
  rootDir: string,
  repoUrlArg: string,
  targetOwnerArg: string,
  forkNameArg: string,
  defaultBranchOnlyArg: string,
): Promise<string> {
  const source = parseRepoUrl(repoUrlArg)
  const explicitTargetOwner = optionalValue(targetOwnerArg)
  const targetOwner = explicitTargetOwner ?? await getGhLogin(rootDir)
  const forkName = optionalValue(forkNameArg) ?? source.name
  const defaultBranchOnly = parseBoolean(defaultBranchOnlyArg, false)

  validateGhSegment(targetOwner, 'targetOwner')
  validateGhSegment(forkName, 'forkName')

  const targetFullName = `${targetOwner}/${forkName}`
  const existingFork = await getRepoInfo(rootDir, targetFullName)
  if (existingFork) {
    const parentFullName = existingFork.parent?.nameWithOwner
    if (!existingFork.isFork || !sameRepo(parentFullName, source.fullName)) {
      throw new Error(`目标仓库已存在但不是 ${source.fullName} 的 fork: ${targetFullName}`)
    }
  } else {
    await forkRepo(rootDir, source.fullName, {
      targetOrg: explicitTargetOwner,
      forkName: forkName !== source.name ? forkName : undefined,
      defaultBranchOnly,
    })
  }

  const forkInfo = await waitForRepo(rootDir, targetFullName)
  const forkUrl = forkInfo.url ?? buildRepoUrl(targetFullName)
  const defaultBranch = forkInfo.defaultBranchRef?.name ?? 'main'

  return [
    existingFork ? 'Fork 已存在。' : 'Fork 创建成功。',
    `源仓库: ${source.fullName}`,
    `Fork 仓库: ${targetFullName}`,
    `Fork URL: ${forkUrl}`,
    `默认分支: ${defaultBranch}`,
  ].join('\n')
}

// ── Clone ──

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
  const cloneDirName = optionalValue(cloneDirNameArg) ?? inferRepoName(repoUrl)
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
