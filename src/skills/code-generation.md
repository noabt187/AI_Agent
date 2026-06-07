---
name: code-generation
description: 代码生成与验证指引 — 按任务列表编写代码并调用 verifyCode 验证，适用于写代码阶段
---

## Skill: 代码生成

当有已确认的任务列表（designTasks 已设置），需要编写代码时：
1. 按任务依赖顺序逐个执行
2. 先用 readTextFile 读取目标文件，理解现状
3. 编写代码后用 writeFile 写入
4. 按需用 deleteFile 删除（需用户确认）
5. 遵循项目现有编码风格，最小改动原则

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
- ✅ 验证通过 → action=done，message 中包含验证摘要
- ⚠️ 验证通过但有契约警告 → 检查 ⚠️ 项，确认是否需要修复
- ❌ 验证未通过 → 根据错误信息修复代码 → 再次调用 verifyCode（最多 3 轮）

3 轮后仍有失败 → action=chat 报告问题，说明哪个环节失败、具体错误信息
