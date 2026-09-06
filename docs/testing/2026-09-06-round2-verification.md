# 第二轮七项问题修复验收（2026-09-06）

## 实施结果

沿用已有 Cordis 宿主和同一份 DSH PageCraft 插件包。当前 web profile 的 `node_modules/dsh-frontend-feedback` 是指向本仓库插件目录的 Junction，重新构建的插件产物直接供现有 Agent 使用；没有另造宿主专用副本，也没有提交或推送。

| 问题 | 修复 | 验收证据 |
| --- | --- | --- |
| R2-01 跨会话运行状态污染 | SessionRuntime 按会话和请求隔离流缓冲、运行/停止状态，后台事件仍归属原会话 | 浏览器 session-007 长请求与 session-008 短请求并发；B 显示 QA-B-OK、就绪、输入和重新生成可用。同刻持久记录 A=running、B=completed。单测覆盖独立缓冲和同会话 FIFO 后继的停止状态 |
| R2-02 刷新后不继续同步 | 当前会话无活动流时串行恢复快照；失败退避至最多 10 秒；终态更新最终消息并停轮询；切换取消旧请求 | 在 session-007 提交 R2-FIX-REFRESH 后首次输出前整页刷新；无需再次操作，页面自动显示 30 条测试点和 QA-REFRESH-DONE，恢复输入。run d88a64d2-4134-43c9-bcd5-329ca03d01be 为 completed |
| R2-03 未保存文件草稿丢失 | IndexedDB 持久化、基准 hash 冲突恢复、revision 安全清理、刷新保护；保存/丢弃期间的新编辑不被旧异步回调覆盖 | 原页面 README 加入 QA-UNSAVED-FIX-20260906，不保存磁盘；独立新加载页面恢复同一标记，显示“已恢复 README.md 的浏览器草稿（尚未写入磁盘）”及未保存。原页面刷新触发确认，由用户协助确认。存储事务失败、冲突、并发保存/丢弃用例通过 |
| R2-04 早期刷新重复用户请求 | 接受前生成稳定 userMessageId，贯穿队列/Orchestrator/Agent/QueryEngine；时间线按 ID 关联，不按文本去重；快照一致性重读 | 刷新后精确匹配 R2-FIX-REFRESH 用户消息计数为 1；单测验证相同文本、不同 UUID 仍显示两条 |
| R2-05 刷新切错会话 | sessionStorage 保存选择；仅当会话已不存在时回退，旧列表响应不能覆盖新选择 | 选中非最新 session-004 后整页刷新，仍为 session-004；存储失效/已删除 ID 回退单测通过 |
| R2-06 无效目录卡住 | 加载/失败/就绪分离，保留上一有效列表，提供主目录/磁盘入口，禁用失败路径确认，中文错误 | 输入 D:\project\__QA_MISSING_20260906__ 后显示“文件夹不存在”，不再显示加载中；点击磁盘根目录恢复 C:/D: 列表，未更改操作目录 |
| R2-07 纯文本点文件不能编辑 | 增加 .gitignore/.gitattributes/.editorconfig/Dockerfile/Containerfile/LICENSE/Makefile，保留大小/路径/NUL/严格 UTF-8 检查 | 浏览器 Conduit .gitignore 显示正常文本编辑器及 text·已保存；文件名和无效 UTF-8/二进制测试通过 |

## 最终自动检查

- `npm test`：89/89 通过，包含根项目 PageCraft 安装/客户端集成。
- `npm run build`：通过。
- `npm --prefix web run build`：通过。
- `npm --prefix plugins/dsh-frontend-feedback run check`：插件构建、67/67 测试及 pack dry-run 通过。
- 独立代码审查：宿主运行管理通过；插件发现的事务提交、丢弃竞争、静默淘汰、失败提示覆盖、敏感命名漏网均修复并复审通过。后续 B→C 保存竞争与丢弃期间输入的修复也已复审通过。
- 测试期间曾遇到 Windows 临时夹 EBUSY 清理竞争，已给生命周期测试清理增加有限重试；最终全量检查通过。

检查噪声：现有插件安装集成输出 Node DEP0190（shell 参数）弃用警告及插件信任提示；仓库 git 环境输出 CRLF/ignore 权限提示。生成的 PageCraft 客户端 bundle 含上游打包产生的空白行尾空格。未把这些噪声报告成测试失败或本轮七项问题已消除之外的保证。

## 保护与边界

- 未保存 Conduit 文件，未安装其依赖、启动数据库、执行代码修改工具、提交或推送。README.md 和 .gitignore 前后 SHA-256 一致，git 工作区无差异。
- README SHA-256：EAE49F05002F4E8E9032609565811AA5AB69EAC88A0018E2D679BF0631FA0365。
- .gitignore SHA-256：4DD81F573672BC56286BEB49E4618F5A42244BE54D04A9903EE6240A7C9CA6C8。
- session-007、session-008 保留验收记录。首次长请求因开发服务重启成为 interrupted，界面正确显示；其后的刷新完成验收独立重跑成功。没有遗留本次运行任务。
- 页面预览仍指向上一轮的 127.0.0.1:65534，502 是该测试地址未运行，不是文件恢复失败。
- 草稿上限为单份 1 MB、100 份；超限明确报错且不静默淘汰未保存草稿。敏感名称文件不自动缓存；浏览器清空站点数据会清除本地草稿。没有跨设备同步保证。
- 未重新运行外部 DSH 宿主；同包兼容性由现有接口、包构建与 AI Agent 插件安装/客户端集成验证。
- QA 标记已从独立验收页面撤销，剩余浏览器草稿清理需用户确认“丢弃 README.md”；磁盘不受影响。临时验收页在确认后关闭。
