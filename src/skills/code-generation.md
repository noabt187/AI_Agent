---
name: code-generation
description: 代码生成指引
trigger: always
---

## Skill: 代码生成

当有已确认的任务列表（designTasks 已设置），需要编写代码时：
1. 按任务依赖顺序逐个执行
2. 先用 readTextFile 读取目标文件，理解现状
3. 编写代码后用 writeFile 写入
4. 按需用 deleteFile 删除（需用户确认）
5. 遵循项目现有编码风格，最小改动原则

## 验证（必须执行）

全部代码编写完成后，必须调用 verifyCode 工具验证：

1. 调用 verifyCode，传入本次修改的所有文件路径（逗号分隔）
   ```
   verifyCode(rootDir, "backend/models/Article.js,backend/controllers/articles.js,frontend/src/services/setArticle.js,frontend/src/components/ArticleEditorForm/ArticleEditorForm.jsx")
   ```

2. 读取返回结果：
   - ✅ 验证通过 → 输出 action=done，message 中包含验证摘要
   - ❌ 验证未通过 → 根据错误信息修复代码 → 再次调用 verifyCode（最多 3 轮）

3. 3 轮后仍有失败 → action=chat 报告问题，说明哪个环节失败、具体错误信息
