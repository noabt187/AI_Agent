# AI Agent — 端到端全栈开发智能体

## 项目简介

本项目是一个**端到端 AI 编程 Agent 系统**，用户通过自然语言描述需求，Agent 自主完成代码分析、需求理解、方案设计、代码编写、质量验证、GitHub PR 提交等全流程，实现从需求到交付的闭环。

核心能力：

- **自主决策**：Agent 通过"观察→思考→行动"循环工作，自主选择工具和技能
- **全栈开发**：支持前后端项目的端到端开发（git clone / 提交pr / fork仓库）
- **代码验证**：两层验证机制（静态分析：npm run build 、 npm run test 等校验 + API 契约检查）
- **GitHub 集成**：支持 Fork、Clone、Commit、Push、Create PR 的完整 Git 工作流
- **流式输出**：基于 SSE 的实时流式响应，前端实时展示 Agent 思考过程
- **Web 控制台**：现代化 Web UI，支持会话管理、记忆管理、Skill 管理
- **DSH 插件架构**：基于 Cordis 的 profile/bundle/plugin 组合，插件可注册路由、Skill、Tool、会话能力和浏览器 Slot
- **PageCraft 可视化评注**：通过同一份 `dsh-frontend-feedback` 插件包提供页面预览、DOM/区域评注、源码工作区和演示文稿工作流
- **记忆系统**：记忆分层设计，分为项目记忆和全局记忆，同时记忆支持模型自动生成和用户手写注入
- **上下文压缩**：自动检测 token 用量，超阈值时压缩上下文

## DSH 兼容插件架构

网页与 CLI 的普通新请求会建立当前任务，不继承旧方案的写权限；历史和已执行结果保留。任务等待补充信息时，回答会修订当前任务版本。确认、修改方案和继续任务均绑定任务及方案版本；旧页面确认、重复确认或已排队但目录/方案变化的请求会被拒绝。带新约束的“确认”应作为新请求或方案修改提交。

网页使用停止按钮暂停当前运行，保留后继排队请求。CLI 的 Esc 同样暂停并返回输入循环。明确输入“继续”或点击“继续任务”可恢复当前任务；只有同任务、同版本、同目录的已批准方案可恢复其写权限。“取消”结束当前任务，历史保留；取消待确认方案则暂停任务。网页 Esc 只属于所在界面，不停止 Agent。“本轮运行结束”不等于“任务完成”：等待补充、等待确认、暂停和任务完成分别显示。

普通 `/api/sessions/:id/stream` 的 `{ prompt }` 契约及 PageCraft `session.prompt(content, 'queue')` 不变。宿主界面可附加 `control: { kind: 'confirm' | 'revise', taskId, taskRevision, confirmationId }`，确认候选时额外传精确 `selection`；继续使用 `{ kind: 'resume', taskId, taskRevision }`。`DELETE /pending-confirm` 需提交 `{ expected: { taskId, taskRevision, confirmationId } }`。接收前的版本冲突返回 409、非法控制返回 400；已开始流式响应的排队请求若过期，则发送错误事件并将该运行持久化为 failed。

AI Agent 现在使用与 DeepSeek Harness 同风格的 Cordis 插件宿主。一个 profile 由 bundle 的 `cordis.patch.yml` 与用户覆写层组成；安装包的 `dsh.bundle.patch` 会自动加入 profile，`dsh.client` 产物会由宿主生成清单并在浏览器中激活。

仓库内的 [`dsh-frontend-feedback`](plugins/dsh-frontend-feedback/README.md) 就是同一份 PageCraft 包：它既能安装到 DeepSeek Harness，也能原样安装到本 AI Agent，不需要 AI Agent 专用分支或适配代码。

### 命令行安装 PageCraft

本地开发使用 `link:`，修改 PageCraft 后无需重新发布：

```powershell
npm run ai-agent -- plugin --profile web add "link:D:\project\AI_Agent\plugins\dsh-frontend-feedback"
npm run ai-agent -- plugin --profile web list
npm run ai-agent -- --profile web --dump-config
```

如果 PageCraft 已发布到 npm，可直接按包名和版本安装：

```powershell
npm run ai-agent -- plugin --profile web add dsh-frontend-feedback@0.3.0
npm run ai-agent -- plugin --profile web update dsh-frontend-feedback
npm run ai-agent -- plugin --profile web remove dsh-frontend-feedback
```

插件被视为可信本地代码：安装脚本和 Node/浏览器代码可以执行，并可在授权工作目录上注册路由、Skill 与 Tool。请只安装你信任的包。profile 默认位于 `~/.ai-agent/profiles/<name>`，可用 `AI_AGENT_HOME` 改变根目录。

## 依赖环境

| 依赖 | 版本要求 | 说明 |
|------|---------|------|
| Node.js | ≥ 22.x | 运行环境 |
| npm | ≥ 9.x | 包管理 |
| pnpm | ≥ 9.x | profile 插件安装与更新 |
| Git | ≥ 2.x | 版本控制（Clone / PR / Commit / Fork 功能需要） |
| GitHub CLI (`gh`) | ≥ 2.x | GitHub 集成（Fork / PR 功能需要，需登录 `gh auth login`） |

**额外要求**：
- LLM API Key（OpenAI 兼容接口）
- 现代浏览器（Chrome / Edge / Firefox，用于 Web 控制台）

## 启动步骤

### 1. 克隆项目并安装依赖

```bash
git clone https://github.com/noabt187/AI_Agent
cd <project-dir>
npm install
```

### 2. 配置 API Key

```bash
cp config/model.example.json config/model.json
```

编辑 `config/model.json`，填入你的 API Key（详见 [配置说明](#配置说明)）。

### 3. 安装 PageCraft（可选）

执行上面的 `plugin --profile web add ...` 命令。不安装 PageCraft 时，对话、记忆、监控、仓库和 Skill 管理仍可正常使用。

### 4. 启动开发环境

```bash
# 同时启动后端服务和前端开发服务器
npm run dev
```

- 后端服务：`http://localhost:3001`
- 前端页面：`http://localhost:5173`

在浏览器打开 `http://localhost:5173`，即可开始使用。

### 5. 命令行模式（可选）

```bash
npm run orchestrator
```

进入交互式命令行模式，直接输入需求与 Agent 对话。按 `ESC` 终止当前操作，输入 `/exit` 退出。如需直接启动指定 profile 的 Web 宿主：

```powershell
npm run ai-agent -- --profile web
```

## 目录结构

```
project_code/
├── config/                         # 配置文件目录
│   ├── model.json                  # [需手动创建] LLM 模型与 API Key 配置
│   └── app.json                    # [可选] 服务端口配置
├── src/                            # 后端源码（TypeScript）
│   ├── config/                     # 配置加载模块
│   │   ├── appConfig.ts            # 应用配置（端口等）
│   │   └── modelConfig.ts          # 模型配置加载
│   ├── context/                    # 上下文管理
│   │   ├── contextCompressor.ts    # 上下文压缩
│   │   ├── modelConfig.ts          # 模型配置
│   │   └── monitor.ts              # 监控与指标统计
│   ├── llm/                        # LLM 客户端层
│   │   ├── index.ts                # 客户端工厂
│   │   ├── types.ts                # 类型定义
│   │   ├── openaiClient.ts         # OpenAI 兼容客户端（含 token 统计）
│   │   ├── anthropicClient.ts      # Anthropic 客户端
│   │   ├── monitoredClient.ts      # 监控包装器（记录 token / 延迟）
│   │   └── sse.ts                  # SSE 流式解析
│   ├── memory/                     # 记忆系统
│   │   └── projectMemory.ts        # 项目记忆存储与召回
│   ├── orchestrator/               # 核心编排层
│   │   ├── agent.ts                # Agent 主循环（system prompt + 工具调用）
│   │   ├── orchestrator.ts         # 顶层编排器（状态管理 + 记忆 + 压缩）
│   │   └── types.ts                # 世界状态类型
│   ├── server/                     # Web 后端
│   │   ├── server.ts               # HTTP 服务入口
│   │   ├── coreRoutes.ts           # 内置 API 的 Cordis 路由插件
│   │   ├── sessionApi.ts           # 会话管理 API
│   │   ├── promptQueue.ts          # 按会话隔离的 FIFO 输入队列
│   │   ├── stream.ts               # SSE 流式输出
│   │   ├── fileBrowser.ts          # 文件系统浏览 API
│   │   └── metrics.ts              # 指标统计 API
│   ├── plugins/                    # DSH 兼容插件宿主
│   │   ├── profile.ts              # profile/bundle 组合
│   │   ├── manager.ts              # pnpm 命令行管理
│   │   ├── host.ts                 # Cordis Loader 启动与生命周期
│   │   ├── clientModules.ts        # dsh.client 清单与产物分发
│   │   └── services/               # Skill、Tool、Session 宿主服务
│   ├── skills/                     # Agent 技能库（Markdown 格式）
│   │   ├── index.ts                # 技能加载器
│   │   ├── registry.ts             # 技能注册
│   │   ├── requirement-analysis.md # 需求分析技能
│   │   ├── solution-design.md      # 方案设计技能
│   │   ├── code-generation.md      # 代码生成与验证技能
│   │   ├── pull-request.md         # PR 提交技能
│   │   ├── repository-tools.md     # 仓库工具技能（Fork / Clone）
│   │   └── auto-memory.md          # 自动记忆技能
│   ├── state/                      # 状态持久化
│   │   └── sessionStore.ts         # 会话消息存储
│   ├── tools/                      # Agent 工具集
│   │   ├── index.ts                # 工具注册表 + 权限控制
│   │   ├── fileRead.ts             # 文件读取工具（readTextFile, listDirectory, searchFiles, searchContent）
│   │   ├── fileWrite.ts            # 文件写入工具（writeFile, deleteFile）
│   │   ├── verifyCode.ts           # 代码验证工具（静态分析 + API 契约检查）
│   │   ├── createPullRequest.ts    # GitHub PR 创建工具
│   │   ├── repositoryTools.ts      # Fork / Clone 仓库工具
│   │   ├── compressContext.ts      # 上下文压缩工具
│   │   └── writeMemory.ts          # 记忆写入工具
│   ├── types/                      # 共享类型
│   │   └── index.ts
│   ├── utils/                      # 工具函数
│   │   ├── index.ts                # UUID、URL 拼接、文本处理
│   │   ├── command.ts              # 命令执行器（execFile 封装）
│   │   ├── git.ts                  # Git 操作库（runGit, commit, push, clone, 分支管理等）
│   │   ├── gh.ts                   # GitHub CLI 操作库（runGh, forkRepo, createPR, parseRepoUrl 等）
│   │   ├── pathUtils.ts            # 路径校验
│   │   └── fileUtils.ts            # 文件工具
│   └── QueryEngine.ts              # 查询引擎（LLM 调用 + 重试 + 流式输出）
├── web/                            # 前端源码（React + Vite + TypeScript）
│   ├── src/
│   │   ├── App.tsx                 # 主应用组件（会话管理、流式交互、确认栏）
│   │   ├── api.ts                  # 后端 API 客户端
│   │   ├── messageContent.ts       # 消息内容渲染
│   │   ├── plugins/                # 浏览器模块、Slot、Session 兼容层
│   │   ├── styles.css              # 全局样式
│   │   └── main.tsx                # 入口
│   ├── index.html
│   ├── package.json
│   └── tsconfig.json
├── scripts/                        # 辅助脚本
│   ├── ai-agent.ts                 # profile 启动与插件命令行
│   ├── orchestrator-chat.ts        # 命令行 Agent 入口
│   └── cleanup-dev-ports.mjs       # 开发端口清理
├── bundles/                        # 内置 DSH profile bundle
├── plugins/                        # 本地插件（包含 PageCraft）
├── state/                          # [运行时] 会话状态持久化目录
├── package.json                    # 根 package.json（npm workspace）
└── tsconfig.json                   # TypeScript 配置
```

## 配置说明

### API Key 配置（config/model.json）

在项目根目录下创建 `config/model.json`：

**OpenAI 兼容接口**（推荐，支持 DeepSeek、豆包、OpenAI 等）：

```json
{
  "provider": "openai",
  "base_url": "https://api.deepseek.com/v1",
  "api_key": "sk-your-api-key-here",
  "model": "deepseek-chat"
}
```

**Anthropic 接口**：

暂且最好不要使用Anthropic接口，没有Anthropic接口的tool calls适配，用Anthropic接口可能会存在问题。

当前只是提供了Anthropic接口，方便之后扩展使用，并没有真正兼容适配。

| 字段 | 类型 | 说明 |
|------|------|------|
| `provider` | `"openai"` | LLM 提供商类型 |
| `base_url` | `string` | API 端点地址 |
| `api_key` | `string` | API 密钥，**请勿提交到 Git** |
| `model` | `string` | 模型名称 |

### 端口配置（config/app.json，可选）

```json
{
  "serverPort": 3001,
  "webPort": 5173
}
```

也可通过环境变量配置：

```bash
# Windows PowerShell
$env:AGENT_SERVER_PORT=4000
$env:AGENT_WEB_PORT=8080

# Linux / macOS
export AGENT_SERVER_PORT=4000
export AGENT_WEB_PORT=8080
```

### GitHub CLI 配置（Fork / PR 功能需要）

若要使用Fork/PR/clone等功能必须要安装Github CLI

```bash
# 安装 GitHub CLI（Windows）
winget install --id GitHub.cli

# 登录
gh auth login
```

如果 `gh` 不在 PATH 中，可先验证安装路径（以 PowerShell 为例）：
```powershell
Get-Command gh | Format-List Source
```
或检查常见安装目录：
- `%USERPROFILE%\bin\gh.exe`
- `%LOCALAPPDATA%\Programs\GitHub CLI\gh.exe`
- `%ProgramFiles%\GitHub CLI\gh.exe`

### npm 工作区

项目使用 npm workspace 管理前后端依赖：

```bash
npm install          # 安装所有依赖（根 + web 工作区）
```

## Agent 工具清单

| 工具 | 权限 | 说明 |
|------|------|------|
| `readTextFile` | read | 读取文件内容 |
| `listDirectory` | read | 列出目录结构 |
| `searchFiles` | read | 按文件名模式搜索 |
| `searchContent` | read | 按关键词搜索代码内容 |
| `verifyCode` | read | 代码验证（tsc / lint / build / test + API 契约检查） |
| `compressContext` | read | 压缩会话上下文 |
| `writeFile` | write | 创建或覆盖文件（需用户确认） |
| `deleteFile` | write | 删除文件（需用户确认） |
| `createPullRequest` | write | 提交改动并创建 GitHub PR（需用户确认） |
| `forkRepository` | write | Fork GitHub 仓库（需用户确认） |
| `cloneRepository` | write | Clone Git 仓库到本地（需用户确认） |
| `writeMemory` | memory | 写入持久化记忆（需先加载 auto-memory 技能） |

**写权限机制**：所有 `write` scope 的工具在执行前必须经过 `action: confirm, confirmType: allow_write` 流程，用户确认后才会执行。

## Agent 技能清单

此为当前Agent内置的skill，用户也可在前端点击上传skill上传自己书写的skill

| 技能 | 说明 |
|------|------|
| `requirement-analysis` | 需求分析指引 |
| `solution-design` | 方案设计指引 |
| `code-generation` | 代码生成与验证指引 |
| `pull-request` | GitHub PR 提交流程 |
| `repository-tools` | Fork / Clone 仓库流程 |
| `auto-memory` | 自动记忆写入流程 |

Agent 根据当前任务自动调用 `use_skill(skillName)` 加载对应技能的完整指引。

## 开发命令

```bash
npm test              # 运行测试
npm run build         # 编译 TypeScript
npm run dev           # 启动开发环境（后端 + 前端）
npm run dev:server    # 仅启动后端
npm run dev:web       # 仅启动前端
npm run ai-agent -- plugin --profile web list  # 查看 profile 插件
npm run test:pagecraft-plugin                 # PageCraft 真实包兼容门
npm run orchestrator  # 启动命令行 Agent
```

## 架构概览

```
用户输入 → Web 控制台 (React + 浏览器 Cordis)
       → dsh.client 模块系统 → Slots / Browser Sessions → PageCraft
       → Cordis WebServer → 内置 API + 插件路由
       → Orchestrator (状态管理 + 记忆 + 压缩 + 会话 FIFO)
         → Agent (system prompt + 工具调用循环)
           → QueryEngine (LLM 调用 + 重试 + 流式输出)
             → LLM Client (OpenAI / Anthropic)
           → Cordis Tool Registry (内置 + 插件 + 权限检查)
           → Cordis Skill Registry (内置 + 插件)
```
