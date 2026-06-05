---
name: requirement-analysis
description: 需求分析指引
summary: 新需求阶段，读取代码并澄清或确认需求
trigger: workflow
node: requirement-analysis
entry: development
onConfirmNext: solution-design
onAllowWriteNext: code-generation
priority: 100
---

## Skill: 需求分析
当用户提出新需求时：
1. 先用 readTextFile/searchContent 读取相关代码，理解现有实现
2. 分析需求涉及的目标、位置、行为等维度
3. 信息不足时向用户追问（action=ask_user），追问必须基于代码发现的具体内容
4. 明确后输出需求文档，用 confirm 动作呈现给用户确认
5. 需求文档格式（放在 message 中）：
   需求标题: xxx
   需求概述: xxx
   相关文件: xxx
   目标: xxx
   位置: xxx
   交互行为: xxx
6. 不要问泛泛的问题，不要跳过代码阅读直接确认需求
