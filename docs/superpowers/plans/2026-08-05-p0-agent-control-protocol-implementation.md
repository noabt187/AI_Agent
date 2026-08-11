# Agent P0 控制协议与工具可靠性实施计划

## 实施原则

- 以小步可验证提交推进，每一阶段先补测试再改实现。
- 保留旧 JSON 终止协议作为兼容路径，但所有新路径优先使用原生控制工具。
- 保留执行层权限校验，不以动态工具隐藏替代安全检查。
- 不暂存或修改用户已有的 `config/model.example.json` 删除状态。

## 阶段 1：共享协议类型与控制工具

涉及文件：

- `src/orchestrator/types.ts`
- `src/orchestrator/controlTools.ts`（新增）
- `src/orchestrator/agent.ts`
- `tests/agent-control.test.ts`（新增）

任务：

1. 增加 capability、授权状态和控制工具参数类型。
2. 定义 `request_confirmation`、`ask_user`、`finish` 的 OpenAI Tool Schema。
3. 实现控制调用到 `AgentResult` 的确定性转换。
4. 实现 Terminal Action 规则：接受首个控制调用，拒绝其后的副作用调用。
5. 将旧 JSON 解析改为尾部合法对象扫描，并暴露 fallback 标记供 Metrics 使用。

验证：原生控制调用、混合 Markdown fallback、多控制调用和控制后写调用测试通过。

## 阶段 2：动态工具暴露与授权生命周期

涉及文件：

- `src/tools/index.ts`
- `src/orchestrator/agent.ts`
- `src/orchestrator/orchestrator.ts`
- `src/orchestrator/types.ts`
- `tests/agent-permission.test.ts`（新增）

任务：

1. 为工具注册表增加 capability 元数据。
2. 提供按 WorldState 生成工具定义的 resolver。
3. 未授权时仅暴露 read/control；确认后按 scope 开放工具。
4. 授权绑定 taskId/authorizationId，并在完成、取消、切目录和新任务时撤销。
5. 执行入口继续复查 capability 和路径。
6. Memory 工具只在本轮加载 `auto-memory` 后加入后续工具集合。

验证：各状态工具清单、绕过执行器、授权撤销和 scope 隔离测试通过。

## 阶段 3：Harness 管理的任务级 Checkpoint

涉及文件：

- `src/checkpoint/checkpointManager.ts`（新增）
- `src/tools/index.ts`
- `src/orchestrator/agent.ts`
- `src/state/sessionStore.ts`
- `tests/checkpoint-manager.test.ts`（新增）

任务：

1. 在 Agent state 中建立任务 Checkpoint Manifest。
2. 对每个首次写入/删除的文件捕获 preimage、存在状态和哈希。
3. 捕获失败时阻止修改。
4. 从模型可见工具中移除 `saveCheckpoint`；显式 destructive revert 走内部服务。
5. 提供只恢复当前任务文件的回退能力和旧 Checkpoint 清理入口。

验证：新增、修改、删除、重复写、脏工作区和选择性恢复测试通过。

## 阶段 4：结构化工具结果

涉及文件：

- `src/tools/types.ts`（新增）
- `src/tools/index.ts`
- `src/orchestrator/agent.ts`
- `eval/harness/runTrial.ts`
- `eval/types.ts`
- 相关工具测试

任务：

1. 定义统一 `ToolResult` 和错误码。
2. 在执行入口把现有字符串工具输出包装成结构化结果，逐步为权限、参数、路径和执行异常返回原生错误码。
3. 发给模型的 tool result 使用精简 JSON；Trace 保存完整结构。
4. 相同调用仅在 `retryable=true` 时重试，最多 2 次。
5. Eval 不再用错误文本前缀判断失败。

验证：错误码、序列化、不可重试失败和 retry exhausted 测试通过。

## 阶段 5：搜索与 Windows 命令修复

涉及文件：

- `src/utils/fileUtils.ts`
- `src/tools/fileRead.ts`
- `src/utils/command.ts`
- `src/tools/verifyCode.ts`
- `tests/tool-platform.test.ts`（新增）

任务：

1. 扩充源码扩展名并增加文件大小限制。
2. `searchFiles` 同时匹配 basename 和标准化相对路径。
3. 增加可单测的平台命令解析函数。
4. Windows 将 Node 包管理器命令解析为 `.cmd`。
5. `verifyCode` 暴露实际命令、退出状态，环境失败不得标记为验证通过。

验证：`.mjs` 文件/内容搜索和 Windows/Linux 命令解析测试通过；本机 fixture 的 `npm test` 可真实执行。

## 阶段 6：模型重试事件隔离

涉及文件：

- `src/types/index.ts`
- `src/QueryEngine.ts`
- `src/orchestrator/types.ts`
- `src/orchestrator/agent.ts`
- `src/server` 中事件转发位置
- `tests/query-engine-retry.test.ts`（新增）

任务：

1. 增加 `retry` SDK/Agent Event。
2. 重试时重置当前失败尝试的文本和工具调用。
3. Retry 事件只进入 UI 状态与 Metrics，不进入 assistant 历史。
4. 重试耗尽返回基础设施错误。

验证：失败尝试文本、工具调用和重试提示均不进入最终结果及消息历史。

## 阶段 7：Eval 适配与最终验证

涉及文件：

- `eval/harness/runTrial.ts`
- `eval/graders/index.ts`
- `eval/report.ts`
- `eval/types.ts`
- `eval/harness/toolContracts.ts`
- `tests/eval-framework.test.ts`

任务：

1. 记录原生控制、fallback、协议违规、Provider retry、真实验证与 Checkpoint 失败指标。
2. 使用 capability 状态判断未授权调用。
3. 扩充 Tool Contract Eval。
4. 运行全部单元测试和 TypeScript Build。
5. 先运行 smoke，再使用相同模型完成 8 类 × 3 次评测。
6. 输出与基线报告的逐项对比及仍存失败轨迹。

完成标准：设计文档第 11 节的确定性验收全部满足；真实 Eval 指标如实报告，不为达到目标修改 grader 或隐藏失败。
