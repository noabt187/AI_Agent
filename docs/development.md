# 配置与开发

[返回项目首页](../README.md) · [架构说明](architecture.md)

以下命令除特别说明外，都在 AI Agent 仓库根目录执行。

## 运行环境

| 依赖 | 用途 |
| --- | --- |
| Node.js 22+、npm 9+ | 安装并运行宿主、Web 控制台 |
| pnpm 9+ | 管理 profile 内的插件依赖 |
| Git | 本地仓库与版本控制 |
| GitHub CLI `gh` | Fork、PR 等 GitHub 操作，需要登录 |
| OpenAI 兼容模型接口 | Agent 推理与工具调用，需要有效 API Key |

根项目使用 npm workspaces，一次 `npm install` 安装根项目、`web` 与内置 bundle 的依赖。PageCraft 是单独的插件包；修改插件源码时，需要另行安装其开发依赖。

## 模型配置

复制 `config/model.example.json` 为 `config/model.json`。PowerShell：

```powershell
Copy-Item config/model.example.json config/model.json
```

Linux / macOS：

```bash
cp config/model.example.json config/model.json
```

若目标文件已存在，直接编辑现有配置，不要覆盖。需要设置的字段为：

| 字段 | 说明 |
| --- | --- |
| `provider` | 当前推荐 `openai`，表示使用 OpenAI 兼容协议 |
| `base_url` | 服务提供方的 API 地址 |
| `api_key` | 你的密钥；不要提交到 Git，也不要出现在截图中 |
| `model` | 服务方支持工具调用的模型名称 |

模型配置从当前工作目录的 `config/model.json` 读取，因此应在仓库根目录启动。Anthropic 客户端虽已预留，但原生工具调用适配尚未完成，不建议作为当前默认配置。

## 端口

默认后端为 `3001`，Web 为 `5173`。可在 `config/app.json` 中配置：

```json
{
  "serverPort": 3001,
  "webPort": 5173
}
```

也可以通过环境变量覆盖，PowerShell 示例：

```powershell
$env:AGENT_SERVER_PORT = '4000'
$env:AGENT_WEB_PORT = '8080'
npm run dev
```

开发脚本包含端口清理逻辑，启动前请注意同端口的其他进程。PageCraft 中应填写目标项目的开发地址；目标项目与 Agent 控制台应使用不同端口。

当前开发环境不应直接暴露到公网；需要共享访问时，应另行处理认证、网络隔离与凭据管理。

## GitHub 登录

确认 `git`、`gh` 可在命令行使用后，执行：

```bash
gh auth login
gh auth status
```

在 Agent 的仓库配置中核对推送仓库、PR 目标和基础分支。审阅文件改动及提交范围后再确认远程操作。

## 插件管理

本地 PageCraft 使用相对路径链接即可，无需修改机器专属路径：

```bash
npm run ai-agent -- plugin --profile web add "link:./plugins/dsh-frontend-feedback"
npm run ai-agent -- plugin --profile web list
npm run ai-agent -- --profile web --dump-config
```

默认 profile 保存在用户目录的 `.ai-agent/profiles/<name>`。可以通过 `AI_AGENT_HOME` 指定其他根目录；宿主默认使用 `web` profile，也可通过 `AI_AGENT_PROFILE` 选择。

插件命令会将安装、更新、移除操作转交给 pnpm。已安装包的管理示例：

```bash
npm run ai-agent -- plugin --profile web update dsh-frontend-feedback
npm run ai-agent -- plugin --profile web remove dsh-frontend-feedback
```

`link:` 插件使用本地目录；更新源码后应重新构建，而不是依赖上述 `update` 命令获取代码：

```bash
npm --prefix plugins/dsh-frontend-feedback install
npm --prefix plugins/dsh-frontend-feedback run build
npm --prefix plugins/dsh-frontend-feedback test
```

重启 Agent 宿主并刷新浏览器，使服务端与客户端都加载新产物。提交插件改动时，保持 `src/` 与已跟踪的 `lib/` 一致。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动后端和 Web 开发服务 |
| `npm run dev:server` | 仅启动后端 |
| `npm run dev:web` | 仅启动 Web 开发服务 |
| `npm run orchestrator` | 进入交互式 CLI；Esc 暂停当前运行，`/exit` 退出 |
| `npm run ai-agent -- --profile web` | 单独启动指定 profile 的宿主，不启动 Vite |
| `npm run build` | 编译宿主 TypeScript |
| `npm run build:web` | 编译并构建 Web 控制台 |
| `npm test` | 运行宿主测试 |
| `npm run test:pagecraft-plugin` | 验证真实 PageCraft 包的安装与浏览器集成 |
| `npm --prefix plugins/dsh-frontend-feedback test` | 运行插件自己的测试 |

部分集成测试需要本机 pnpm 与可用的依赖环境。自动化测试不代表真实模型已经成功生成或验收了某个项目，应结合实际任务检查结果。

## 开发入口

- [`src/orchestrator/`](../src/orchestrator/)：Agent 编排、任务与执行状态。
- [`src/tools/`](../src/tools/) / [`src/skills/`](../src/skills/)：工具实现、权限范围与内置 Skill。
- [`src/context/`](../src/context/) / [`src/memory/`](../src/memory/)：上下文压缩、模型配置与记忆。
- [`src/plugins/`](../src/plugins/) / [`bundles/`](../bundles/)：profile、插件加载与宿主服务。
- [`web/src/`](../web/src/)：控制台、任务交互和浏览器插件扩展。
- [`plugins/dsh-frontend-feedback/`](../plugins/dsh-frontend-feedback/)：PageCraft 独立插件源码、构建产物与测试。

工具权限以 [`src/tools/index.ts`](../src/tools/index.ts) 为准。例如，代码验证可能执行仓库脚本，因此不能简单地视作无副作用的文件读取。
