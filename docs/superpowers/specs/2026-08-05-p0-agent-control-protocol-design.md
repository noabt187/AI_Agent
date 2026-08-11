# Agent P0 控制协议与工具可靠性改造设计

## 1. 背景

现有本地评测包含 8 类任务、24 次 Trial。只读定位、需求澄清和过期 Memory 抵抗任务稳定通过，但单文件修复与跨文件修改均为 0/3。轨迹表明模型已经给出正确修改方案和 `confirm(allow_write)` JSON，但最终回复同时包含 Markdown、代码块和 JSON；`parseAgentResult` 从第一个 `{` 截取到最后一个 `}`，误把代码片段当作 JSON，导致确认动作被降级为普通聊天，自动确认和写入阶段没有发生。

此外，评测还暴露出以下 P0 问题：

- 未授权阶段仍向模型暴露写工具，产生 5/24 次未授权写入尝试；底层虽然阻止了实际修改，但控制面不可靠。
- `saveCheckpoint` 由模型负责调用，模型可能提前调用、重复调用或遗漏调用；Git commit 还可能把用户原有未提交改动一起纳入。
- 文件搜索扩展名白名单不包含 `.mjs`，导致实际存在的 `slug.mjs` 和 `slugify` 无法被搜索工具发现。
- Windows 使用 `execFile("npm")`/`execFile("npx")` 时出现 `ENOENT`，验证工具不能真实运行测试。
- 429/5xx 重试提示作为模型文本增量进入最终回复，污染控制协议、会话历史和评测轨迹。
- 工具结果依赖“错误”“工具执行错误”等文本前缀判断状态，无法稳定区分权限、参数、环境和业务失败。

本设计修复上述 P0 问题。本期不实现 Git Sandbox，不引入统一 Shell 工具，也不重写现有 Skills。

## 2. 目标与非目标

### 2.1 目标

1. 使用原生 Tool Calling 表达确认、追问和结束动作，不再依赖混合文本中的 JSON 作为主控制协议。
2. 根据当前授权状态动态暴露工具，同时保留执行层权限复查。
3. 由 Harness 自动维护任务级文件 Checkpoint，不要求模型调用存档工具。
4. 修复 `.mjs` 等源码搜索和 Windows Node 包管理器命令执行。
5. 将模型服务重试与最终回答分离。
6. 使用结构化工具结果和明确错误码驱动错误恢复与评测。
7. 补充确定性回归测试，并复跑现有 24 次 Agent Eval 形成前后对比。

### 2.2 非目标

- 不增加 Docker、WSL、Git worktree 或操作系统级 Sandbox。
- 不把文件工具统一替换成 Shell。
- 不改变 Fork、Push、PR 的业务语义。
- 不在本期优化 Context 压缩策略或批量重写 Skill。
- 不宣称本地评测属于 SWE-bench。

## 3. 总体架构

系统分为五个边界清晰的组件：

1. **Control Action Layer**：定义 `request_confirmation`、`ask_user`、`finish` 三个虚拟控制工具，将模型意图转换成 `AgentResult`。
2. **Capability Resolver**：根据 Agent 状态生成本轮模型可见的工具集合。
3. **Tool Executor**：负责 Schema、权限、路径和 Skill Gate 校验，执行工具并返回结构化结果。
4. **Checkpoint Manager**：在文件首次被当前任务修改前保存该文件的前置状态。
5. **Retry/Event Layer**：把模型服务重试记录为控制事件，不混入模型成功响应和持久化历史。

`Orchestrator` 仍是权限和任务状态的唯一事实来源；模型不能通过输出文本自行改变权限。

## 4. 原生控制工具协议

### 4.1 控制工具

新增以下虚拟工具，它们由 Agent 直接解释，不进入普通业务工具注册表：

```ts
request_confirmation({
  message: string,
  prompt: string,
  scope: "workspace_write" | "remote_git" | "destructive_revert"
})

ask_user({
  message?: string,
  questions: string[]
})

finish({
  message: string,
  outcome: "answered" | "completed"
})
```

映射规则：

- `request_confirmation` 转换为 `AgentResult.action="confirm"`，同时保存申请的 capability scope。
- `ask_user` 转换为 `AgentResult.action="ask_user"`。
- `finish(outcome="answered")` 转换为只读回答，`finish(outcome="completed")` 转换为修改任务完成。
- 两种 `finish` 都表示当前任务已经终止，必须清理任务状态并撤销授权；需要继续等待用户输入时必须使用 `ask_user` 或 `request_confirmation`。

控制工具是 Terminal Action。一旦某一批 Tool Calls 中出现控制工具：

1. 只允许执行控制工具之前已经完成的只读调用。
2. 不执行同批次中控制工具之后的任何调用。
3. 如果同批次同时包含控制工具与写工具，写工具一律拒绝并记录协议违规。
4. 一个批次包含多个控制工具时只接受第一个，其余记录为无效调用。

### 4.2 兼容策略

原生控制工具是主协议。现有 `parseAgentResult` 暂时保留为兼容 fallback：

1. 没有原生控制调用且存在最终文本时，先尝试从尾部扫描最后一个可独立解析、且 `action` 合法的 JSON 对象。
2. 解析成功时返回兼容结果并增加 `protocolFallbackCount`。
3. 解析失败时把纯文本视为 `finish(outcome="answered")`，不得从文本推断写权限。

系统提示词删除 `///"` 这类非标准转义要求，明确要求模型优先使用控制工具。兼容解析器只用于迁移期，后续由评测数据决定是否删除。

## 5. 权限状态机与动态工具暴露

### 5.1 状态

```text
READ_ONLY
  -> request_confirmation(scope)
AWAITING_CONFIRMATION
  -> 用户确认
AUTHORIZED(scope, authorizationId, taskId)
  -> 执行工具
EXECUTING
  -> finish(completed) / 取消 / 新任务
READ_ONLY
```

授权必须绑定 `taskId` 和递增的 `authorizationId`。以下情况立即撤销授权：

- `finish(outcome="completed")`
- 用户取消任务
- 用户提出与当前目标不同的新任务
- 会话切换工作目录
- 执行 destructive revert 后

### 5.2 能力分类

- `read`：`readTextFile`、`listDirectory`、`searchFiles`、`searchContent`。
- `workspace_write`：`writeFile`、`deleteFile`、`cloneRepository`。Clone 是本地目录导入操作，使用相同的路径与写权限约束。
- `local_execute`：`verifyCode`。执行测试或构建可能创建缓存，因此仅在 `workspace_write` 授权后暴露。
- `remote_git`：`createPullRequest`、`forkRepository`；只在单独的 `remote_git` 授权后暴露。
- `memory`：`writeMemory`；继续要求本轮先加载 `auto-memory` Skill。
- `control`：三个控制工具和 `use_skill`。

工具可见性：

- `READ_ONLY`：`read + control`。
- `AUTHORIZED(workspace_write)`：`read + workspace_write + local_execute + control`。
- `AUTHORIZED(remote_git)`：`read + remote_git + control`，不隐式获得普通文件写权限。
- Memory 工具只有在 `auto-memory` 已加载后动态加入，而不是始终暴露。

`executeTool` 继续执行第二层 capability、绝对路径和 `allowedPaths` 校验。动态隐藏是控制面，执行层复查是安全面，两者不可互相替代。

## 6. 任务级 Checkpoint

`saveCheckpoint` 从模型可见工具中移除，显式回退仍由 Orchestrator 在获得 `destructive_revert` 确认后调用内部服务。

普通修改使用非提交式任务 Checkpoint，避免污染 Git 历史或收录用户原有改动：

- 每次 `writeFile`/`deleteFile` 执行前调用 `CheckpointManager.capture(filePath)`。
- 同一任务中每个文件只捕获第一次修改前的状态。
- 对已有文件保存原始内容、大小、哈希和权限信息；对新文件记录 `existed=false`。
- Manifest 保存 `sessionId`、`taskId`、`authorizationId`、创建时间和文件记录。
- 回退只恢复 Manifest 中的文件：已有文件恢复原内容，新建文件删除。
- 捕获失败时拒绝执行写入，不能在没有可恢复点的情况下继续。
- Checkpoint 数据保存在 Agent state 目录，不写入用户仓库。

任务完成后保留 Manifest 供审计和显式回退；清理策略按数量和保存天数执行，本期默认保留最近 20 个任务或 30 天，以先达到可用性，后续可配置。

## 7. 结构化工具结果

所有业务工具统一返回：

```ts
type ToolResult = {
  ok: boolean
  code: string
  message: string
  retryable: boolean
  data?: Record<string, unknown>
}
```

最低错误码集合：

- `OK`
- `UNKNOWN_TOOL`
- `INVALID_ARGUMENTS`
- `PATH_OUTSIDE_ALLOWED`
- `PERMISSION_DENIED`
- `CHECKPOINT_FAILED`
- `COMMAND_NOT_FOUND`
- `COMMAND_FAILED`
- `TIMEOUT`
- `REMOTE_SIDE_EFFECT_BLOCKED`
- `TOOL_EXECUTION_FAILED`

LLM 收到序列化后的简洁结果；Trace 保留完整结构。评测不再使用中文或英文错误前缀正则判断成功失败。

对于完全相同的工具名和标准化参数：

- `retryable=false` 时不自动重试相同调用。
- `retryable=true` 时最多重试 2 次，并记录原因。
- 达到上限后向模型返回 `RETRY_EXHAUSTED`，要求改变方法或报告阻塞。

## 8. 搜索与 Windows 验证修复

### 8.1 搜索

源码扩展名至少增加：`.mjs`、`.cjs`、`.mts`、`.cts`、`.py`、`.java`、`.kt`、`.go`、`.rs`、`.sh`、`.ps1`、`.yaml`、`.yml`、`.toml`。

`searchFiles` 的 pattern 同时匹配：

- 统一使用 `/` 的相对路径。
- 文件 basename。

保留忽略 `.git`、`node_modules`、构建目录和状态目录的规则，并增加单文件大小上限，避免把大型二进制或生成文件读入 Context。

### 8.2 命令执行

`runCommand` 增加平台解析层：

- Windows：`npm -> npm.cmd`、`npx -> npx.cmd`，并覆盖 `pnpm.cmd`、`yarn.cmd`。
- 非 Windows：保持无扩展名命令。
- 继续使用 `execFile` 和参数数组，不拼接 Shell 字符串。

`verifyCode` 返回实际命令、退出码、stdout/stderr 摘要和各检查项状态。`COMMAND_NOT_FOUND` 属于环境失败，不得被模型表述为“验证通过”；逻辑推演只能作为分析说明，不能替代测试结果。

## 9. 模型服务重试

`QueryEngine` 为重试增加独立事件：

```ts
{ kind: "retry", attempt, maxAttempts, reason, delayMs }
```

行为要求：

- 每次新尝试开始时清空上一次失败尝试的文本和 Tool Calls。
- `retry` 事件可以展示在 UI 状态区，但不写入 assistant message。
- 只有最终成功尝试进入会话历史和 `fullText`。
- 所有尝试失败时返回明确的基础设施错误，不生成伪造的 Agent 回复。
- Metrics 记录 `providerRetryCount`、最终 HTTP 错误类型和因重试增加的延迟。

## 10. 测试与评测

### 10.1 确定性单元和集成测试

必须新增：

1. Markdown/代码块中存在大括号，尾部存在合法旧 JSON 时，fallback 能解析最后一个动作。
2. 原生控制工具优先于同一回复中的普通文本。
3. 控制工具后面的写调用不会执行。
4. `READ_ONLY` 的工具定义中不存在写工具与验证工具。
5. 确认后只暴露对应 capability 的工具。
6. 任务完成、取消和新任务会撤销授权。
7. 即使绕过可见性直接调用 executor，未授权写入仍被拒绝。
8. 第一次修改每个文件前只捕获一次原始状态；回退不影响任务外文件。
9. `.mjs` 文件名搜索与内容搜索成功。
10. Windows 命令解析产生 `npm.cmd`/`npx.cmd`，非 Windows 保持原命令。
11. 验证工具不能把 `COMMAND_NOT_FOUND` 判为通过。
12. 失败模型尝试的文本和重试提示不进入最终结果或持久化历史。
13. 工具结果和 Eval Trace 使用结构化 `ok/code/retryable`，不再依赖错误前缀。

### 10.2 Agent Eval

保留原 8 类任务、每类 3 次，用相同模型和配置复跑，保证前后可比。评测 Harness 同步适配原生控制工具和结构化工具结果。

新增报告字段：

- `nativeControlActionRate`
- `protocolFallbackRate`
- `protocolViolationRate`
- `providerRetryRate`
- `verificationExecutionRate`
- `checkpointFailureRate`

## 11. 验收标准

确定性门槛：

- 所有既有测试和新增测试通过。
- TypeScript Build 通过。
- Tool Contract Eval 通过，且覆盖 `.mjs` 搜索、Windows shim、动态工具可见性和结构化错误。
- 未授权状态下模型拿不到写工具；执行层绕过测试仍会拒绝写入。
- 重试提示不出现在最终 Agent 消息。
- 工作区中已有的用户改动不被 Checkpoint 提交、覆盖或恢复。

真实评测观察目标，不作为代码合并的硬性条件：

- `single-file-fix` 和 `cross-file-contract` 能进入确认及写入阶段，不再因文本 JSON 解析稳定失败。
- Permission Violation Attempt Rate 从 20.8% 降低到 0%。
- Out-of-scope Change Rate 保持 0%。
- Windows 环境的 `verifyCode` 实际执行测试。
- `protocolFallbackRate` 可被量化，并逐步降至接近 0。

如果真实模型服务在评测期间持续 5xx，报告必须把该 Trial 标记为 infrastructure error 或 degraded，不得用它评价 Agent 逻辑能力。

## 12. 实施顺序

1. 引入共享 `ToolResult` 与 capability 类型，保持旧工具实现可逐步迁移。
2. 实现三个原生控制工具及兼容 fallback。
3. 实现权限状态机和动态工具暴露。
4. 实现 Harness 管理的文件级 Checkpoint，并隐藏模型侧 `saveCheckpoint`。
5. 迁移业务工具到结构化结果。
6. 修复源码搜索和 Windows 命令解析。
7. 重构模型服务 retry 事件。
8. 更新 Eval Harness、补充测试、运行 Build 和 24 次对比评测。

## 13. 风险与缓解

- **供应商不支持原生 Tool Calling**：保留旧 JSON fallback，并记录使用率；不从文本授予权限。
- **工具结果类型迁移面较大**：执行入口先兼容字符串结果并统一包装，随后逐个工具原生化。
- **Checkpoint 占用磁盘**：按任务数量和保存天数清理，单文件设置大小上限；超限时拒绝自动修改并说明原因。
- **动态隐藏工具降低模型认知**：系统提示明确说明确认后将开放哪些 capability，但不发送不可用工具的 Schema。
- **真实模型结果仍波动**：确定性测试作为合并门槛，24 次 Eval 只用于观测行为变化，并保留完整 Trace。
