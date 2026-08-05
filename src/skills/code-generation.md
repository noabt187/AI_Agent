---
name: code-generation
description: 代码生成与验证指引 — 按任务列表编写代码并调用 verifyCode 验证，适用于写代码阶段
---

## Skill: 代码生成

当有已确认的任务列表（designTasks 已设置），需要编写代码时：
1. 文件修改前的 Checkpoint 由 Harness 自动维护，不要自行提交存档
2. 按任务依赖顺序逐个执行
3. 先用 readTextFile 读取目标文件，理解现状
4. 编写代码后用 writeFile 写入
5. 按需用 deleteFile 删除；未获得 workspace_write 权限时先调用 request_confirmation
6. 遵循项目现有编码风格，最小改动原则

## 验证（必须执行）

全部代码编写完成后，必须调用 verifyCode 验证：

```
verifyCode(rootDir)
```

verifyCode 执行两层验证：

**第一层：静态分析**
自动检测项目可用的命令并运行：npx tsc --noEmit → lint → build → test。不可用的命令会跳过，不影响验证结论。

**第二层：API 契约**
扫描全项目源文件，提取后端路由定义（Express router.get/post 等）和前端 API 调用（fetch / axios），检查是否匹配。

读取返回结果：
- ✅ 验证通过 → finish(outcome="completed")，message 中包含验证摘要
- ⚠️ 验证通过但有契约警告 → 检查 ⚠️ 项，确认是否需要修复
- ❌ 验证未通过 → 根据错误信息修复代码 → 再次调用 verifyCode（最多 3 轮）

2 轮后仍有失败 → finish(outcome="completed") 如实报告阻塞，说明哪个环节失败、具体错误信息，不得声称验证通过
