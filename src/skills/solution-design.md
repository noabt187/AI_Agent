---
name: solution-design
description: 方案设计指引
trigger: has_requirement_no_tasks
---

## Skill: 方案设计
当需求已明确（goal 已设置），需要设计实现方案时：
1. 读取需求涉及的文件，理解代码结构和依赖关系
2. 识别项目编码模式（命名、结构、样式方案）
3. 按执行顺序拆解为任务列表
4. 每个任务 = 一个文件的一次修改，用自然语言描述
5. 用 confirm 动作呈现任务列表给用户确认
6. 任务格式（放在 message 中）：
   T1 [create/modify/delete] 标题
     文件: xxx
     描述: xxx
     原因: xxx
     依赖: 无/T2
