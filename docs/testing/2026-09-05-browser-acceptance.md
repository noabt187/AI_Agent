# AI Agent 浏览器验收记录（2026-09-05）

## 范围与环境

- 通过 Codex 右侧浏览器操作 `http://localhost:5173/`，不是直接调用后端 API 替代界面测试。
- 目标试验仓库：`D:\project\Agent_test_project\conduit-realworld-example-app`。
- 新建测试会话：`session-002`（项目读取与插件入口）、`session-003`（草稿隔离、停止和恢复）。原有 `session-001` 未用于发送测试请求。
- 对 Agent 发送的请求限定为只读分析或纯文本回复，未要求修改源码、安装依赖、提交或推送。
- 证据来自实际页面状态与截图；下列代码位置是随后进行的只读定位，不表示已经实现修复。

## 已复现问题

### QA-06 / P1：Windows 下 verifyCode 无法启动 npm，构建与测试在执行前失败

步骤：目标目录设置成功后，通过 session-002 请求实际调用 verifyCode，禁止安装依赖、修改文件和启动开发服务。

实际：根测试和 frontend 构建均返回 `spawn npm ENOENT`，没有真正执行测试或编译。

交叉验证：本机 `Get-Command npm,npm.cmd,node` 分别解析到 `D:\nodejs\npm.ps1`、`D:\nodejs\npm.cmd`、`D:\nodejs\node.exe`；直接运行 `npm --version` 返回 `11.16.0`；通过项目自身 `runCommand('npm', ['--version'], process.cwd())` 返回 `{code: 'ENOENT', message: 'spawn npm ENOENT'}`。

代码依据：`src/tools/verifyCode.ts` 的 `runCmd` 按空白拆分命令，交给 `src/utils/command.ts`；后者直接 `execFileAsync(file, args, ...)`，未处理 Windows npm 的脚本入口。最小复现说明问题在命令执行封装，不能仅解释为“没装 npm”。Agent 最终将其直接归因于 PATH/沙箱，诊断证据不足。

建议：使用支持 Windows 的可靠进程启动封装或解析 npm CLI 后用 Node 启动，保留参数边界、超时和退出码；为 Windows npm/npx 添加真实执行验证。试验仓库本身尚未安装依赖是后续独立前提，不是本次 ENOENT 的充分解释。

### QA-07 / P2：API 契约检查不识别项目的 axios 调用方式，产生大量未匹配警告

实际：verifyCode 基线报告出现 22 条“前端未找到对应调用”。Agent 随后读取 service 文件，识别到大部分警告来自检测器局限，未直接修改试验源码。

交叉证据：试验项目 `frontend/src/services/userLogin.js` 使用 `axios({method: 'POST', url: 'api/users/login', ...})`；`toggleFav.js` 使用同类对象参数、动态 method 和模板 URL。`src/tools/verifyCode.ts` 只识别 `axios.get/post/...('...')`，不解析 `axios({...})`；其路径判断要求 `/` 开头或包含 `/api/`，也不接受 `api/users/login`；后端只提取局部 route 字符串，未合成 Router 挂载路径。

建议：支持 axios 配置对象、相对 API 地址与 Router 挂载前缀；无法静态确定时输出“未解析/覆盖不足”，避免将其呈现为完整契约验证结论。此次只验证到检测器误报，未据此判定所有业务 API 正确。

### QA-01 / P1：目录选择依赖浏览器外的原生窗口，网页没有等待状态或可主动使用的回退入口

步骤：新建 session-002，点击“选择操作目录”。

实际：网页中未出现目录选择器、加载状态或提示；仍可以打开仓库配置、PageCraft 等其他界面。用户补充确认：必须最小化浏览器才能看到原生目录弹窗，即弹窗被浏览器遮挡。随后让 Agent 只读分析目标仓库，Agent 报告可操作目录仍只有 `D:\project\AI_Agent`，目标路径被拒绝，无法继续项目测试。

代码依据：`web/src/App.tsx` 的 `handlePickDirectory` 在 Windows 上先等待 `pickDirectory`，只有它返回空路径或抛错才打开网页目录选择器；`src/server/fileBrowser.ts` 的 `pickDirectory` 调用服务端 PowerShell 的 `FolderBrowserDialog.ShowDialog()`，没有窗口 owner、显式置前或超时。该原生窗口不在当前右侧浏览器操作范围内，其被遮挡的现象由用户确认。

建议：网页目录浏览/路径输入作为始终可用的入口；原生选择器作为可选操作，显示等待、取消和回退选项。

### QA-02 / P1：未发送草稿跨会话保留

步骤：在 session-002 输入 `QA-DRAFT-SESSION-002：这条未发送的草稿只属于当前测试会话。`，不发送，点击“新建会话”。

实际：标题切换为 session-003，但输入框仍显示上述草稿，发送按钮可用。用户容易将一个项目的请求误发到另一个会话。测试草稿随后被替换为停止测试请求，没有误发。

代码依据：`web/src/App.tsx` 的 `prompt` 是 App 级 state；`handleNewSession` 及 selectedSessionId 变化的 effect 没有按 session 保存/恢复或清空该 state。

建议：按 sessionId 保存草稿；新会话初始化为空，切回原会话恢复对应草稿。

### QA-03 / P2：PageCraft 默认预览地址与 Agent 自身地址冲突

步骤：新会话点击“打开 PageCraft”，再打开“文件”。

实际：预览地址默认为 `http://localhost:5173/`，预览 iframe 里加载了完整 Agent Console；文件工作区的预览同样显示 Agent Console。用户首先看到的是嵌套控制台，而不是试验项目。

代码依据：`plugins/dsh-frontend-feedback/src/shared.ts` 的 `DEFAULT_PREVIEW_URL` 写死为 `http://localhost:5173`，恰好是该 Agent 的开发页面地址。

建议：未配置预览目标时显示空状态和地址输入；支持宿主传入当前项目开发服务地址，并提示目标与宿主相同时可能选错。

### QA-04 / P2：取消状态没有保留在会话历史

步骤：session-003 发送纯文本长回复请求，点击“停止”；看到“操作已取消”。随后发送 `停止后恢复测试：请只回复 QA-RECOVERY-OK，不要调用工具。`，得到正确回复；刷新页面。

实际：停止成功且可以继续使用，但后续同步/刷新后的历史仅显示原始长回复请求、恢复请求和 `QA-RECOVERY-OK`；取消状态不再可见。无法从历史区分“主动取消”和“请求丢失/未回复”。

建议：持久化每次运行的完成/失败/取消状态，以独立状态项恢复显示。

### QA-05 / P3：插件 Skill 来源被显示成“上传”

步骤：点击 Skill 区域“管理”。

实际：PageCraft 的 `frontend-page-builder` 和 `presentation-builder` 均显示“启用 / 上传”，实际上它们来自已安装插件。

代码依据：`src/plugins/services/skills.ts` 已返回 `source: 'plugin'`；`web/src/App.tsx` 只将 builtin 显示为“内置”，其他值全部显示为“上传”。

建议：显式区分内置、上传和插件，并展示所属插件名称。

## 通过项

- 新建会话成功，旧会话仍在列表中。
- 目录权限拒绝生效：Agent 读取目标仓库失败后明确报告拒绝，没有编造技术栈或脚本。
- PageCraft 客户端入口、网页/演示文稿模式、文件工作区能打开。
- 两个 PageCraft Skill 出现在管理列表中。
- 已完成对话的监控数据可加载：session-002 显示 2 次模型调用、8,163 总 Token。首次切入曾短暂出现“暂无监控信息”，后续加载正常；不判定为数据丢失。
- 停止操作最终退出生成状态，显示“操作已取消”。
- 停止后的恢复请求返回精确文本 `QA-RECOVERY-OK`。
- 页面刷新后测试会话和正常消息恢复。
- 用户处理原生弹窗后，网页目录回退入口出现，目标仓库最终选中，界面显示“目录已更新”。
- 目录设置后的代码理解用例：Agent 实际读取 README、三份 package.json、vitest 配置并搜索测试文件。主要技术栈、workspaces 和脚本描述与文件一致。
- 验证失败反馈：实际调用 verifyCode，并明确说明构建和测试未执行，没有宣称通过；发现契约告警后主动只读核对 service 实现。
- PageCraft 文件树实际连接到目标仓库，成功打开根 package.json，编辑器内容与磁盘一致。未保存修改。

## 本轮未覆盖

目标仓库已选为 session-002 的操作目录，已完成真实仓库代码理解和 verifyCode 调用。但测试/构建因命令启动问题未真正执行，仓库依赖也尚未安装；本轮未继续小范围代码修改、项目服务启动、PageCraft DOM 评注到代码修改的完整闭环。不能将以上通过项视为 coding 能力的端到端验收通过。

下一轮应先修复 QA-06 与 QA-01，安装试验项目依赖并完成基线，再测试一个可逆的小修改和 PageCraft 评注与队列。会话 session-002 保留了读取和验证请求及结果，session-003 保留停止/恢复用例。

本轮未修复 AI Agent 源码；保留测试会话作为复现证据。
