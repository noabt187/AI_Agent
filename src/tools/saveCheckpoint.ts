import { runGit, isGitRepo } from '../utils/git.js'

export async function saveCheckpointTool(
  rootDir: string,
  message: string,
  revertTo: string,
): Promise<string> {
  // 回退模式
  if (revertTo?.trim()) {
    await runGit(rootDir, ['reset', '--hard', revertTo.trim()])
    return `✅ 已回退到 ${revertTo.trim().slice(0, 7)}\n后续改动已丢弃。`
  }

  // 不是 git 仓库就初始化
  if (!(await isGitRepo(rootDir))) {
    await runGit(rootDir, ['init'])
  }

  // 保存模式
  const m = message?.trim() || new Date().toISOString().slice(0, 19).replace('T', ' ')
  await runGit(rootDir, ['add', '-A'])
  await runGit(rootDir, ['commit', '--allow-empty', '-m', `checkpoint: ${m}`])
  const hash = (await runGit(rootDir, ['rev-parse', 'HEAD'])).slice(0, 7)

  return `✅ 存档已创建\ncommit: ${hash}\nmessage: checkpoint: ${m}`
}
