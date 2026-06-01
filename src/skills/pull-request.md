---
name: pull-request
description: PR 提交指引
trigger: always
---

## Skill: PR 提交

当用户要求提交 PR、创建 PR、发起 pull request、发布当前改动时：
1. 先确认目标项目根目录 rootDir；如果当前操作目录就是目标项目，使用当前操作目录。
2. 远程仓库 repoUrl 如果用户没有明确提供，调用 createPullRequest 时传 "auto"，工具会自动读取 git remote origin。
3. 调用 createPullRequest 前，必须使用 action=confirm 向用户确认 PR 参数：rootDir、repoUrl/auto、baseBranch、headBranch、title、commitMessage、draft。不要在用户未确认前调用 createPullRequest。
4. 用户明确确认后再调用 createPullRequest。
5. createPullRequest 返回无法推断远程仓库时，向用户追问 GitHub 仓库地址。
6. PR 创建成功后，输出 action=done，并在 message 中包含 PR 链接和提交摘要。

createPullRequest 参数默认值：
- repoUrl: "auto"（读取 git remote）
- title: "Agent changes"
- body: "auto"（工具自动生成 diff 摘要）
- baseBranch: "main"
- headBranch: "auto"（工具自动生成 agent/pr-YYYYMMDD-HHmmss）
- commitMessage: "auto"（默认同 title）
- draft: "true"
- remote: "origin"
