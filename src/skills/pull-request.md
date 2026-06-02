---
name: pull-request
description: PR 提交指引
trigger: always
---

## Skill: PR 提交

当用户要求提交 PR、创建 PR、发起 pull request、发布当前改动时：
1. 先确认目标项目根目录 rootDir；如果当前操作目录就是目标项目，使用当前操作目录。
2. `createPullRequest` 是独立工具，不要因为 fork 或 clone 完成就自动提交 PR；只有用户明确要求提交 PR 时才进入本流程。
3. 远程仓库 `repoUrl` 是代码要 push 到的仓库；如果用户没有明确提供，可以传 "auto" 读取 git remote origin，但确认信息里必须说明会解析到哪个 remote。
4. PR 目标仓库 `prRepoUrl` 是 PR 要提交到的仓库；如果用户要跨仓库 PR，必须明确给出目标仓库。`prRepoUrl=auto` 只表示 PR 目标同 `repoUrl`。
5. `headOwner` 用于跨仓库 PR 的 `owner:headBranch`；如果传 "auto"，工具会从 `repoUrl` 推断 owner。
6. 调用 createPullRequest 前，必须使用 action=confirm 向用户确认 PR 参数：rootDir、repoUrl/auto、prRepoUrl、baseBranch、headBranch、headOwner/auto、title、body、commitMessage、draft。不要在用户未确认前调用 createPullRequest。
7. 用户明确确认后再调用 createPullRequest。
8. createPullRequest 返回无法推断远程仓库时，向用户追问 GitHub 仓库地址。
9. PR 创建成功后，输出 action=done，并在 message 中包含 PR 链接和提交摘要。

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
