---
name: pull-request
description: PR 提交指引
trigger: pull_request_request
---

## Skill: PR 提交

当用户要求提交 PR、创建 PR、发起 pull request、发布当前改动时：
1. 先确认目标项目根目录 rootDir；如果当前操作目录就是目标项目，使用当前操作目录。
2. PR 提交是带副作用的发布操作；确认 PR 参数时必须输出 `action=confirm` 且 `confirmType="allow_write"`。
3. `createPullRequest` 是独立工具，不要因为 fork 或 clone 完成就自动提交 PR；只有用户明确要求提交 PR 时才进入本流程。
4. 远程仓库 `repoUrl` 是代码要 push 到的仓库；如果用户明确提供了 GitHub 仓库地址，优先把它作为 `repoUrl`，不要传 "auto"。
5. PR 目标仓库 `prRepoUrl` 是 PR 要提交到的仓库；如果用户给的是目标仓库地址，通常 `repoUrl` 和 `prRepoUrl` 都使用这个地址。`prRepoUrl=auto` 只表示 PR 目标同 `repoUrl`。
6. 不要默认 fork。只有用户明确要求 fork，或 createPullRequest 因推送权限失败后用户确认改走 fork，才调用 `forkRepository`。
7. `headOwner` 用于跨仓库 PR 的 `owner:headBranch`；同仓库 PR 可传 "auto"。
8. 调用 createPullRequest 前，必须使用 `action=confirm, confirmType="allow_write"` 向用户确认 PR 参数：rootDir、repoUrl、prRepoUrl、baseBranch、headBranch、headOwner/auto、title、body、commitMessage、draft。不要在用户未确认前调用 createPullRequest。
9. 用户明确确认后再调用 createPullRequest。
10. 不要用 execCommand 探测 `git status`、`git remote`、`gh auth`；createPullRequest 工具会自行检查 git 和 gh 状态。缺少参数时用 ask_user，参数足够时直接确认 PR 参数。
11. createPullRequest 返回无法推断远程仓库时，向用户追问 GitHub 仓库地址。
12. PR 创建成功后，输出 action=done，并在 message 中包含 PR 链接和提交摘要。

createPullRequest 参数默认值：
- repoUrl: "auto"（读取 git remote）
- title: "Agent changes"
- body: "auto"（工具自动生成 diff 摘要）
- baseBranch: "main"
- headBranch: "auto"（工具自动生成 agent/pr-YYYYMMDD-HHmmss）
- commitMessage: "auto"（默认同 title）
- draft: "true"
- remote: "origin"
- prRepoUrl: "auto"（同 repoUrl；跨仓库 PR 时应显式填写目标仓库）
- headOwner: "auto"（从 origin/repoUrl 推断）
