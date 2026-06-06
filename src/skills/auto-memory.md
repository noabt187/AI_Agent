---
name: auto-memory
description: 自动记忆写入指引 — 保存长期可复用的项目/全局 Markdown 记忆
---

Use this skill only when there is a durable, non-obvious fact worth preserving for future work.

## When To Write
- Write memory for reusable user preferences, feedback about how the agent should work, project constraints, external references, or decisions that are not already obvious from code or git history.
- Do not write memory for temporary task progress, generic completion summaries, repo structure, code facts that can be re-read, or anything that only matters in the current conversation.
- Before compressing context, preserve only the facts that would still matter in a future session.

## Layer Choice
- `global`: user preferences, working-style feedback, or cross-project guidance.
- `project`: current project constraints, durable decisions, goals, or PM guidance tied to this repository.
- Do not use session memory for auto memory.

## Writing Rules
Call `writeMemory` once for each useful memory item:
- `layer`: `project` or `global`
- `name`: short kebab-case slug, for example `memory-tool-gate`
- `description`: one-line recall hook
- `type`: `user`, `feedback`, `project`, or `reference`
- `body`: concise fact body

For `project` and `feedback` memories, the body must include:

```text
Why: ...
How to apply: ...
```

If no durable memory is worth saving, do not call `writeMemory`.
