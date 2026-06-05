---
name: repository-tools
description: 仓库 fork 和 clone 工具指引
summary: fork/clone 仓库参数确认和执行
trigger: repository_request
node: repository-tools
entry: repository_request
onAllowWriteNext: repository-tools
priority: 200
---

## Skill: 仓库工具

`forkRepository`、`cloneRepository`、`createPullRequest` 是三个独立工具。不要把它们当成固定流水线，也不要因为调用了其中一个就自动调用另一个。
这些工具都是带副作用的仓库操作。调用前必须输出 `action=confirm` 且 `confirmType="allow_write"` 让用户确认参数。

### forkRepository

当用户要求 fork 仓库，或前端 fork 按钮触发仓库 fork 时：

1. 只调用 `forkRepository`。
2. 它只创建远程 fork，不 clone 到本地，不创建分支，不提交 PR。
3. 调用前用 `action=confirm, confirmType="allow_write"` 让用户看清楚源仓库、目标账号/组织、fork 名称、是否只 fork 默认分支。
4. 调用后返回 fork 仓库 URL，后续是否 clone 由用户或前端下一步动作决定。

forkRepository 参数默认值：
- targetOwner: "auto"（当前 gh 登录账号）
- forkName: "auto"（同源仓库名）
- defaultBranchOnly: "false"

### cloneRepository

当用户要求 clone 仓库，或前端 clone 按钮触发本地 clone 时：

1. 只调用 `cloneRepository`。
2. 它只 clone 指定仓库到本地目录，不 fork，不创建 PR。
3. 用户可以指定 clone 的父目录和目录名；如果没有指定，使用当前操作目录和仓库名。
4. 如果用户明确要求添加额外 remote，例如 upstream，才传 `upstreamUrl` 和 `upstreamRemoteName`。
5. 调用前用 `action=confirm, confirmType="allow_write"` 确认本地目标目录、remote 名称和可选 upstream。
6. 调用后返回本地目录，后续代码分析和修改可以把操作目录切到该目录。

cloneRepository 参数默认值：
- cloneParentDir: "auto"（当前操作目录）
- cloneDirName: "auto"（从仓库地址推断）
- remoteName: "origin"
- upstreamUrl: "auto"（不添加额外 remote）
- upstreamRemoteName: "upstream"
