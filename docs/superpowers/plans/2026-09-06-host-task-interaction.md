# Host-owned Task Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变 PageCraft 插件的情况下，让用户在插件上方查看真实 Agent 状态并安全确认、补充、停止任务。

**Architecture:** 服务端沿用 RunStore/TaskState，保存展示来源和结果摘要，并校验跟进及停止归属。前端以纯函数投影权威状态，通过一个共用动作控制器和宿主原生 dialog 完成交互，旧插件公开接口不变。

**Tech Stack:** TypeScript、React 18、Node test runner、tsx、jsdom、现有 Cordis 插件宿主、HTMLDialogElement。

**Spec:** `docs/superpowers/specs/2026-09-06-host-task-interaction-design.md`

## Global Constraints

- 不修改 `plugins/dsh-frontend-feedback` 中任何源码、Skill、清单、测试或构建包；不重建、不重装插件。
- 不修改 DeepSeek Harness 或当前 PPT 项目、预览服务器。
- 不改变插件调用 `session.prompt(content, 'queue')`、订阅或 `getSnapshot().running` 的语义。请求被接受不等于执行完成；等待确认不伪装为运行中。
- 不读取、替换或隐藏 PageCraft 内部 DOM 文案，不拦截其请求来伪造任务成功，不自动点击插件按钮。
- 保留现有 Cordis、单会话 FIFO、RunStore、TaskState、版本化确认和工具写权限检查；不新增数据库或另一套任务调度器。
- 不处理此前发现的插件初始化 `response.json is not a function` 问题；该问题需要修改共享插件，属于另一个范围。
- 在当前工作区实施，保留所有现有未跟踪文件；只提交本任务文件，不推送远程。

执行说明：本会话未提供上述执行配套技能；可在当前会话按下面的测试循环执行，不假装已经加载它们。

---

### Task 1: 运行元数据、跟进和精确停止

**Files:**
- Modify: `src/state/runStore.ts`, `src/server/sessionApi.ts`, `src/server/coreRoutes.ts`, `src/server/promptQueue.ts`
- Modify: `src/orchestrator/types.ts`, `src/orchestrator/taskInput.ts`, `src/orchestrator/taskState.ts`
- Test: `tests/run-store.test.ts`, `tests/task-state.test.ts`, `tests/prompt-queue.test.ts`, `tests/session-run-lifecycle.test.ts`

**Interfaces:**
- Produces: `RunOrigin = 'composer' | 'plugin'`; `RunResultMeta = { action: AgentResult['action']; protocolFallback?: true }`; optional `RunRecord.origin/resultMeta`.
- Produces: `TaskInputControl` 新分支 `{ kind: 'followup'; taskId: string; taskRevision: number; sourceRunId: string }`。
- Produces: `SessionPromptQueue.abort(sessionId: string, expectedRunId?: string): Promise<void>` 和相同的 `abortSession` 参数。
- Consumes: 现有 `beginTaskTurn`, `RunStore.update`, `PromptJob.binding`, `ownsTurn`。

- [ ] **Step 1: 添加失败测试。** 在现有测试 helper 上覆盖元数据重载、后续说明清权、旧 sourceRunId 拒绝和旧停止请求不影响后继运行。

```ts
const s = state(); proposal(s)
const approved = beginTaskTurn(s, bindTaskInput(s, '确认'))
const control = { kind: 'followup', taskId: s.task!.id,
  taskRevision: s.task!.revision, sourceRunId: approved.runId } as const
const next = beginTaskTurn(s, bindTaskInput(s, '请重新整理方案，先不执行', control))
assert.equal(next.taskRevision, approved.taskRevision + 1)
assert.equal(canWriteTask(s, next), false)
assert.throws(() => beginTaskTurn(s, bindTaskInput(s, '重复回复', control)), /任务|运行/)
```

- [ ] **Step 2: 验证失败。** `node --import tsx --test tests/run-store.test.ts tests/task-state.test.ts tests/prompt-queue.test.ts tests/session-run-lifecycle.test.ts`，预期新增控制／参数尚未生效的断言失败。
- [ ] **Step 3: 实现元数据。** 更新 RunStore 的类型及可更新字段；源自请求的 origin 严格枚举校验；resultMeta 只能由服务端 result 事件产生，在最终 terminal 更新前写入。

```ts
if (event.type === 'result') {
  await runStore.update(job.sessionId, record.id, {
    resultMeta: { action: event.result.action,
      ...(event.result.action === 'chat' && event.result.protocolFallback
        ? { protocolFallback: true as const } : {}) },
  })
}
```

- [ ] **Step 4: 实现控制。** followup 在接收和执行时验证 taskId/revision/lastRunId；服务端核对来源 Run 已终止且无其他活动 Run。作为 revise 清空授权并递增 revision。停止在读取队列当前项后同步核对 expectedRunId，返回 409 冲突，不切到后继项。

```ts
if (c.kind === 'followup' && (task.lastRunId !== c.sourceRunId
  || !['active', 'awaiting_input'].includes(task.phase))) {
  throw new TaskStateError('stale_followup', '任务或运行已改变，请重新查看')
}
```

- [ ] **Step 5: 运行测试与后端构建。** 重跑 Step 2，`npm run build`；旧调用不带元数据或 expectedRunId 仍通过。
- [ ] **Step 6: 精确提交本任务服务端文件和测试。** `git commit -m "feat: bind host task followups and run controls"`。

### Task 2: 权威状态投影与前端恢复

**Files:**
- Create: `web/src/taskInteraction.ts`, `tests/task-interaction.test.ts`
- Modify: `web/src/api.ts`, `web/src/sessionRuntime.ts`, `tests/session-runtime.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `RunRecord.origin/resultMeta`、原 `TaskState` 和 `SessionDetail`。
- Produces: `deriveTaskInteraction(detail: SessionDetail | null, runtime: InteractionRuntime): TaskInteraction | null`。
- `InteractionRuntime`: `{ running: boolean; aborting: boolean; syncing: boolean; submitting: boolean }`。
- `TaskInteraction`: `key`, `sessionId`, `status`, `label`, `origin`, `run?`, `task?`, `confirmation?`, `reply`, `queued`, `actionable`, `autoOpen`, `canFollowup`, `canResume`, `canStop`。
- Produces: `SessionRuntime.detail(id): SessionDetail | null`, `interactionRuntime(id): InteractionRuntime`。不替换原 timeline 和 running 接口。

- [ ] **Step 1: 创建基于完整 SessionDetail 的失败测试。** 用一个 active Task 和 completed Run 模拟协议回退，不能生成确认按钮。

```ts
const detail: SessionDetail = { id: 's', running: false, messages: [],
  state: { sessionId: 's', allowedPaths: [], task: {
    id: 't', revision: 1, objective: '目录', phase: 'active', lastRunId: 'r',
    previousContext: [], completedTaskIds: [], failedTaskIds: [] } },
  runs: [{ id: 'r', sessionId: 's', prompt: '目录', status: 'completed',
    createdAt: 1, messageIds: [], taskId: 't', taskRevision: 1,
    resultMeta: { action: 'chat', protocolFallback: true } }] }
const view = deriveTaskInteraction(detail,
  { running: false, aborting: false, syncing: false, submitting: false })!
assert.equal(view.status, 'needs_attention')
assert.equal(view.confirmation, undefined)
assert.equal(view.canFollowup, true)
```

- [ ] **Step 2: 运行新测试确认失败。** `node --import tsx --test tests/task-interaction.test.ts tests/session-runtime.test.ts`。
- [ ] **Step 3: 实现纯投影。** 按当前 Task.lastRunId 选择关联运行，按运行状态展示活动项／队列；匹配 session/task/revision 才开放操作。对失败、取消、不同步、旧字段缺失使用设计表中的保守状态。

```ts
const task = detail.state.task
const run = detail.runs?.find(r => r.id === task?.lastRunId && r.sessionId === detail.id)
const owned = !!run && run.taskId === task?.id && run.taskRevision === task?.revision
const terminal = !!run && !['queued', 'running'].includes(run.status)
const canFollowup = owned && terminal && !runtime.running && !runtime.syncing
  && (task?.phase === 'active' || task?.phase === 'awaiting_input')
```

- [ ] **Step 4: 保存 SessionRuntime 的已核实 detail 和 run/task 事件。** begin 标记提交中；run 绑定服务端身份；流末尾进入核实；权威快照解除 syncing。乱序快照保护仍由现有 token 校验决定。
- [ ] **Step 5: 扩展 HTTP 客户端可选 origin/expectedRunId、结构化 HTTP 错误 code/status。** 不改变 Plugin PromptResult。增加旧运行、队列后继、取消晚到、未知归属、其他会话事件的测试并重跑 Step 2。
- [ ] **Step 6: 提交投影与恢复代码。** `git commit -m "feat: derive authoritative host task status"`。

### Task 3: 共用操作和宿主顶层界面

**Files:**
- Create: `web/src/useTaskInteractionActions.ts`, `web/src/TaskInteractionContent.tsx`, `web/src/TaskInteractionHost.tsx`
- Modify: `web/src/App.tsx`, `web/src/styles.css`
- Create: `tests/task-interaction-ui.test.tsx`

**Interfaces:**
- Consumes: `TaskInteraction` 与 `deriveTaskInteraction`。
- Produces: `useTaskInteractionActions`，输入当前 interaction、读取当前身份、submit/refresh/revoke/stop 回调；输出 `busy`, `error`, `confirm`, `revise`, `followup`, `resume`, `stop`, `revoke`。
- Produces: `TaskInteractionContent({ interaction, actions })`；表单草稿按 interaction.key 隔离，主聊天和 dialog 只挂载一份活动表单。
- Produces: `TaskInteractionHost({ interaction, actions, onRefresh })`；负责 status portal 与原生 dialog 生命周期，不持有服务端任务副本。

- [ ] **Step 1: 创建真实 DOM 测试。** 模拟 showModal/close 仅供 jsdom，分别测试正式确认、无记录回复、重复按钮、迟到回调、收起和 Escape 不触发服务端控制。

```ts
assert.equal(document.querySelector('[data-host-task-status]')?.textContent?.includes('等待确认'), true)
assert.equal(document.querySelector('dialog')?.open, true)
document.querySelector('dialog')!.dispatchEvent(new window.KeyboardEvent('keydown',
  { key: 'Escape', bubbles: true, cancelable: true }))
assert.equal(stopCalls.length, 0)
assert.equal(revokeCalls.length, 0)
```

- [ ] **Step 2: 运行新 DOM 测试确认失败。** `node --import tsx --test tests/task-interaction-ui.test.tsx`。
- [ ] **Step 3: 实现动作控制器。** 捕获显示身份，以 ref 锁定交互键；409 或未知网络失败触发快照核实，不自动重试；跟进与停止携带 Task 1 的引用。重新整理请求由用户点击且使用无授权 followup。

```ts
await submit(view.sessionId, '确认', {
  kind: 'confirm', taskId: p.taskId, taskRevision: p.taskRevision,
  confirmationId: p.id, ...(selection ? { selection } : {}),
})
```

- [ ] **Step 4: 实现 UI。** 状态卡 portal z-index 高于 10000 且只占自身区域；dialog 用 showModal，标题获得焦点，Escape 局部捕获阻止传播，cancel 仅收起。交互 key 首次可见才自动打开，隐藏页恢复先请求快照。

```ts
function onEscape(event: React.KeyboardEvent) {
  if (event.key !== 'Escape') return
  event.stopPropagation()
  event.preventDefault()
  if (!event.nativeEvent.isComposing) dismiss()
}
```

- [ ] **Step 5: App 接线。** submitPrompt 保留 source；宿主自己的控制提交不清空聊天草稿。移走重复确认表单，主区域改用同一入口；停止按钮共用精确停止动作，旧运行不明时禁用。PageCraft launcher 不卸载，旧 session facade 原样保留。
- [ ] **Step 6: 重跑 DOM 测试、状态测试和 `npm run build:web`。** 测试选项、修订、回复、正常 chat 不自动弹出、异步任务切换、对话框草稿和 IME。
- [ ] **Step 7: 提交 UI。** `git commit -m "feat: expose host task interactions above plugins"`。

### Task 4: 同包回归与真实浏览器验收

**Files:**
- Modify: `tests/pagecraft-client.integration.test.tsx`
- Create: `docs/testing/2026-09-06-host-task-interaction.md`

**Interfaces:**
- Consumes: 已有 `bootBrowserPluginRuntime`, `SlotOutlet` 和 Task 3 的宿主组件。
- Produces: 实际执行的自动／浏览器检查记录，明确未验证项。

- [ ] **Step 1: 补真实 bundle 的 DOM 集成。** 打开 PageCraft 后向宿主渲染可控的确认；检查插件 dialog 仍挂载、宿主确认可见，Escape 不退出插件且不停止运行。

```ts
assert.ok(document.querySelector('[aria-label="PageCraft"]'))
assert.ok(document.querySelector('dialog[data-host-task-dialog]'))
assert.equal(pluginPromptCalls.length, 0, 'opening/dismissing a host dialog never submits a plugin task')
```

- [ ] **Step 2: 运行全量验证。** `npm test`、`npm run build`、`npm run build:web`、`npm run test:pagecraft-plugin`、在插件目录执行 `npm test`（不 build）。所有新增失败必须查明原因。
- [ ] **Step 3: 浏览器验证。** 使用临时测试会话／可控事件夹具，覆盖确认、收起、异常回复、停止身份、插件草稿保留、窄屏、页面隐藏恢复；真实用户 session-012 只读检查，不提交生成任务。原生 dialog 叠层与焦点以浏览器结果为准。
- [ ] **Step 4: 核对插件完全不变。**

```powershell
git diff ebf139fa5d5b0eec3eac2c05de00df8e19cd4e42 --exit-code -- plugins/dsh-frontend-feedback
Get-FileHash plugins/dsh-frontend-feedback/lib/client.js,plugins/dsh-frontend-feedback/lib/index.js -Algorithm SHA256
```

预期 client SHA256 `7051CDA227B15821225BEA639032373D34D7BB08B9EF37049FA5D82C7369278B`；server `F551F809507D79720E811F1C46850AD397B5F2704A23A5DB99AD8280F0343C6D`。

- [ ] **Step 5: 写验收结果并提交。** 明确插件内部文字／初始化异常仍属未修改边界；不声称 DSH 本轮另做了验收；只提交本次文件，不推远程。

## Self-review

- 设计第 1–3 节边界由全局约束与 Task 4 保证；第 4/7 节由 Task 3 实现；第 5 节由 Task 1/2 实现；第 6 节由 Task 1/3 实现；第 9 节由 Task 4 完成。
- 可选 API 字段、状态类型、组件名称在本计划内定义；不要求 PageCraft 读取新增字段。
- 任务归属、回退诊断、控制并发与真实 dialog 检查均有独立测试循环。
