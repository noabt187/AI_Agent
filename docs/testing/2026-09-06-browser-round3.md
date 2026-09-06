# 第三轮浏览器探索测试（2026-09-06）

## 范围与结论

- 被测版本：`623ff4a6bbb611a99d3087dc2ae8960dea097d49`，分支 `lwm_dev`。
- 入口：`http://localhost:5173/`，Codex 右侧浏览器；真实点击、键盘输入和会话请求。
- 实验仓库：`D:\project\Agent_test_project\conduit-realworld-example-app`。
- 本轮新增 `session-009`、`session-010`，验证任务取消、后续指令、PageCraft 弹窗和编辑器状态。
- 确认 4 项问题。浏览器现象结合本地运行记录、源码及只读确定性检查交叉验证。
- 仅测试和记录，没有实施产品修复，没有保存实验仓库文件，没有提交或推送。本报告不代表全功能验收，也未重跑上一轮全量自动测试。

## R3-01 / P1：取消任务后，旧目标压过新指令

### 复现与实际结果

1. 在 `session-009` 发送：`R3-ESC：只用文字列出100项测试检查点，每项一句话。不要调用工具，不要读写文件。`
2. 运行期间打开 PageCraft，在预览地址框按 Esc。该请求被取消，详见 R3-02。
3. 发送新指令：`R3-READ：只读检查当前 Conduit 项目。请读取根目录、frontend、backend 三个 package.json，分别列出实际存在的 dev、test、build 脚本；不存在的明确说不存在。不要执行 npm，不安装依赖，不写入或修改任何文件。`
4. Agent 没有调用工具，最终回答却以“R3-ESC：Conduit RealWorld 应用 100 项测试检查点如下。”开头，列出旧任务的 100 项检查点。界面显示“执行完成”。

预期：执行最新的只读文件检查；停止旧运行不能让旧目标覆盖新的明确指令。

运行证据：

- 旧 run `66d3ca5d-5f00-447c-89c2-eaff45a22002`：`cancelled`。
- 新 run `9b704388-f226-4f3c-9bf1-afd4d6c5b678`：`completed`，但未完成新请求。
- `state/session-009/messages.json`：两条用户消息之后的回答属于旧任务，没有工具消息。
- `state/session-009/orchestrator-state.json`：`goal` 仍为 `R3-ESC` 原文。

### 对照组

新建 `session-010`，设置同一目录，发送完全相同的 `R3-READ` 指令。Agent 调用目录/搜索工具及 3 次 `readTextFile`，正确回答实际脚本。run `b5ffb8da-05ac-4417-ac26-6ac9d42489d0` 为 `completed`。

| package.json 位置 | dev | test | build |
| --- | --- | --- | --- |
| 根目录 | concurrently 同时启动前后端 | vitest | 不存在 |
| frontend | vite | 不存在 | vite build |
| backend | node --watch index.js | 不存在 | 不存在 |

这些结果另以本地只读文件检查核实。因此不是文件工具整体不可用。本次样本证明该失败路径存在，不表示每次模型请求都会同样失败。

### 原因定位与修复方向

- `src/orchestrator/orchestrator.ts:232`：仅在没有旧 `goal` / `confirmedRequirement` 时设置用户目标。
- `src/server/sessionApi.ts:62`、`src/orchestrator/orchestrator.ts:86`：停止运行只触发 abort，没有经过文本“取消”对应的任务状态清理。
- `src/orchestrator/agent.ts:83`：残留目标仍作为“用户目标”提供。
- `src/QueryEngine.ts:17`：临时上下文被放到最新用户输入的前面；这里不是系统消息，但会给同一轮提供相互冲突的目标。

应明确区分长期背景目标、当前任务和当前请求；为停止/继续/替换任务定义状态转换，新指令替换旧任务时更新活动目标。不能简单把所有停止都解释为清空全部上下文，也不能只依赖模型猜测哪个目标有效。增加“停止 A → 提交 B → 仅执行 B”的集成测试。

## R3-02 / P1：在 PageCraft 按 Esc 关闭弹窗，会同时取消 Agent

### 复现与证据

Agent 运行时打开 PageCraft，把焦点放在“预览地址”输入框，按 Esc。弹窗关闭，同时主界面出现“正在停止”，最终显示“操作已取消”。后台 run 也成为 `cancelled`，不是单纯显示异常。

预期：Esc 优先关闭当前弹窗，不应附带取消背景任务。

### 原因定位与修复方向

- `web/src/App.tsx:593`：全局 `window.keydown` 收到任何 Escape 就调用 `handleAbort()`，没有检查弹窗、焦点或事件归属。
- `plugins/dsh-frontend-feedback/src/client/index.tsx:924`：PageCraft 同时监听全局 Escape 关闭自身。
- 文件工作区另有全局 Escape 处理，位于 `source-workspace.tsx:345`；本轮直接复现的是预览地址框路径。

应建立宿主与插件共同遵守的快捷键/弹层优先级；顶层弹窗先消费事件，聊天停止仅在合适作用域触发。两个监听器都挂在 window，仅在其中随意增加 `stopPropagation()` 未必足够，需验证监听顺序和同一目标上的处理。

## R3-03 / P1：丢弃草稿后，编辑器仍显示已丢弃内容，却标成“已保存”

### 复现与证据

1. 在 PageCraft 文件工作区打开 `.gitignore`。
2. 在末尾输入 `R3-DISCARD`，不保存文件。
3. 点击“丢弃修改”；用户协助确认浏览器原生确认框。
4. 页面显示“已丢弃 .gitignore 的浏览器草稿。”、`text · 已保存`，保存按钮禁用，但编辑区末尾仍显示 `R3-DISCARD`。

关闭此文件标签并重新打开后，测试字符才消失，内容恢复磁盘原文。本轮已通过此步骤清理，无磁盘写入。

### 原因定位与修复方向

- `source-workspace.tsx:740`：丢弃操作将 React 中的 `draft` 重置为磁盘内容。
- `source-workspace.tsx:194`：CodeMirror 仅在初始化时使用 `value`，effect 依赖为 `path` 和 `revealLine`，没有同步外部内容重置。
- `source-workspace.tsx:1062`：编辑器 key 由路径、文件 hash、定位 revision 决定；丢弃不改变这些值，因此不会重建编辑器。

浏览器已确认“可见内容与保存状态不一致”。根据变更监听器会回传完整编辑器内容，后续输入还存在重新带回已丢弃文本的风险；本轮未执行再次编辑后保存，不声称磁盘已被污染。

应增加明确的编辑器内容重置机制，在丢弃、恢复、切换版本等外部更新后同步文档；区分用户编辑和外部重置，处理撤销栈，避免重置又被当成新草稿。组件测试须同时断言编辑器实际文本、dirty 状态和缓存内容。

## R3-04 / P2：CRLF 文件编辑后撤销仍“未保存”，保存有全文件换行改写风险

### 复现与证据

1. 新打开 Conduit `.gitignore`，初始为 `text · 已保存`。
2. 在末尾输入 `R3-UNDO`，按 Ctrl+Z。
3. 测试字符消失，但状态仍为 `text · 未保存`，出现“丢弃修改”按钮。

对实际文件及插件所用 CodeMirror 执行只读检查：

| 项目 | 磁盘原文 | EditorState 文档转字符串 |
| --- | --- | --- |
| 字符数 | 574 | 531 |
| CRLF 数量 | 43 | 0 |
| 与磁盘原文相同 | — | 否 |
| 与原文 CRLF→LF 后相同 | — | 是 |

### 原因定位与修复方向

- `source-workspace.tsx:171` 使用 `update.state.doc.toString()` 回传文档，初始化没有保留原换行约定。
- `source-workspace.tsx:310` 用字符串严格比较判断 dirty；视觉撤销后换行仍不同。
- `source-workspace.tsx:687` 保存发送整个 draft，意味着正常编辑也可能带来换行格式差异。本轮未点击保存，因此没有实际改写磁盘。

应保留读取时的换行约定并在序列化时恢复，dirty 比较也应采用一致策略；混合换行和 BOM 行为需明确。增加 CRLF 文件的输入/撤销、保存后字节比较测试，不能只测 LF 文本。

## 清理与验证边界

- `session-009` 中本轮 `.gitignore` 草稿已确认丢弃，关闭并重开文件验证测试标记消失；PageCraft 已关闭。未处理其他轮次的旧草稿。
- 保留 `session-009`、`session-010` 及运行记录供复现；本轮 3 个运行均已结束，没有遗留进行中的任务。
- Conduit `git status --short` 无输出。README 和 `.gitignore` SHA-256 与测试前一致：
  - README：`EAE49F05002F4E8E9032609565811AA5AB69EAC88A0018E2D679BF0631FA0365`。
  - .gitignore：`4DD81F573672BC56286BEB49E4618F5A42244BE54D04A9903EE6240A7C9CA6C8`。
- 对照组只调用只读工具，未运行 Conduit npm 脚本、安装依赖、启动服务、写入文件或操作 Git。
- 本轮未复测外部 DSH 宿主、真实网页评注/演示文稿、断网、超大文件及所有多标签竞态，不对这些路径作通过结论。
- 优先修复 R3-01（任务指令正确性）、R3-02（误停止）和 R3-03（编辑状态一致性），随后修复 R3-04（换行保真）。
