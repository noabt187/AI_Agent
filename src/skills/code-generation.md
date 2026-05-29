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
6. 全部任务完成后，输出 action=done 并总结修改内容
