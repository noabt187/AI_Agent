import {
  runGit,
  addAll,
  commit,
  pushUpstream,
  getCurrentBranch,
  getDiffStat,
  getRemoteUrl,
  remoteExists,
  addOrSetRemote,
  branchExists,
  createAndCheckout,
  validateRefName,
  validateRemoteName,
  timestampBranch,
} from '../utils/git.js'
import {
  runGh,
  checkGhReady,
  createPR,
  parseRepoUrl,
  optionalValue,
  parseBoolean,
  type RepoRef,
} from '../utils/gh.js'

// ── Tool ──

export async function createPullRequestTool(
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
  // 确保是 git 仓库
  try { await runGit(rootDir, ['rev-parse', '--is-inside-work-tree']) } catch {
    return '错误：当前目录不是 git 仓库。'
  }

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

  // 确定推送仓库
  const explicitRepoUrl = optionalValue(repoUrlArg)
  let pushUrl: string
  if (explicitRepoUrl) {
    await addOrSetRemote(rootDir, remoteName, explicitRepoUrl)
    pushUrl = explicitRepoUrl
  } else {
    const remoteUrl = await getRemoteUrl(rootDir, remoteName)
    if (!remoteUrl) {
      return `错误：无法推断远程仓库。请让用户提供 repoUrl，或先在项目中配置 git remote "${remoteName}"。`
    }
    pushUrl = remoteUrl
  }

  const ghError = await checkGhReady(rootDir)
  if (ghError) return ghError

  const pushRepo = parseRepoUrl(pushUrl)
  const explicitPrRepoUrl = optionalValue(prRepoUrlArg)
  const prRepoUrl = explicitPrRepoUrl ?? pushUrl
  const prRepo = parseRepoUrl(prRepoUrl)
  const headOwner = optionalValue(headOwnerArg) ?? pushRepo.owner

  // 切换/创建 head 分支
  const currentBranch = await getCurrentBranch(rootDir)
  if (currentBranch !== headBranch) {
    if (await branchExists(rootDir, headBranch)) {
      return `错误：本地分支 "${headBranch}" 已存在。请换一个 headBranch，或先切到该分支后重试。`
    }
    await createAndCheckout(rootDir, headBranch)
  }

  // 提交 & 推送
  await addAll(rootDir)
  await commit(rootDir, commitMessage)

  const diffStat = await getDiffStat(rootDir)
  await pushUpstream(rootDir, remoteName, headBranch)

  const body = bodyFromUser ?? [
    'Agent 自动提交的变更。',
    '',
    '```',
    diffStat,
    '```',
  ].join('\n')

  const prOutput = await createPR(rootDir, {
    repo: prRepo.fullName,
    base: baseBranch,
    head: `${headOwner}:${headBranch}`,
    title,
    body,
    draft,
  })

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
