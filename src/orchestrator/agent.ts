import { resolve } from 'node:path'
import { QueryEngine } from '../QueryEngine.js'
import { createLlmClient } from '../llm/index.js'
import type { MetricCallback } from '../llm/index.js'
import { loadModelConfig } from '../context/modelConfig.js'
import { executeTool, getToolDescriptionsForScope, toolDefsToOpenAI } from '../tools/index.js'
import type { WriteConfirmFn } from '../tools/index.js'
import { loadSkills, getActiveSkills } from '../skills/index.js'
import type { AgentEventHandler, WorldState, AgentResult } from './types.js'
import type { LlmToolCall } from '../llm/types.js'

const MAX_TOOL_ITERATIONS = 30
const MAX_TOOL_RETRIES = 3
const SYS_UUID = 'agent-sys-001'

const SKILLS_DIR = resolve(import.meta.dirname ?? process.cwd(), '../skills')

// ── System Prompt ──────────────────────────────────────────────────

function buildSystemPrompt(allowedPaths: string[], worldStateContext: string, activeSkillTexts: string[]): string {
  return `你是全栈开发助手。通过读取代码、分析需求、设计方案、编写代码来帮助用户完成开发任务。

## 可操作目录
${allowedPaths.join('\n')}
工具调用的 rootDir 必须使用以上目录之一。

## 当前状态
${worldStateContext}

## 工作方式
你通过"观察→思考→行动"循环工作：
1. 观察：理解用户说了什么、之前做了什么、项目状态如何
2. 思考：决定下一步做什么
3. 行动：调用工具读取/写入代码，或回复用户

当你需要调用工具时，使用工具调用功能（不要在文本中输出工具调用格式）。
当你准备好回复用户时，输出以下 JSON 格式。

## 可用工具
${getToolDescriptionsForScope('write')}

## 输出格式
当你要回复用户时（不调用工具时），只输出 JSON，不要输出其他内容：
{"thinking":"你的分析思路","action":"chat|ask_user|confirm|done","message":"给用户的消息","questions":["问题1"],"prompt":"确认内容","confirmType":"requirement|design"}

action 说明：
- chat：直接回复用户（普通对话、回答问题）
- ask_user：需要用户提供更多信息，questions 数组不能为空
- confirm：呈现方案或任务列表，等待用户确认，prompt 为确认内容
  - confirmType="requirement"：需求分析完成，message 中包含需求文档
  - confirmType="design"：方案设计完成，message 中包含任务列表和需要修改的文件
- done：任务完成，message 为完成总结

## 重要工作流程
当用户提出开发需求时，必须按以下顺序执行：
1. 需求分析：读取代码，理解现状，输出需求文档 → action=confirm, confirmType=requirement
2. 等待用户确认需求后 → 方案设计：拆解任务，列出需要修改的文件 → action=confirm, confirmType=design
3. 等待用户确认方案后 → 代码编写：按任务逐个编写代码 → action=done
不要跳过任何步骤，不要在用户未确认需求时就开始写代码。

${activeSkillTexts.join('\n\n')}`
}

// ── WorldState Context ─────────────────────────────────────────────

function buildWorldStateContext(state: WorldState): string {
  const parts: string[] = []

  if (state.goal) parts.push(`用户目标: ${state.goal}`)
  if (state.confirmedRequirement) {
    const preview = state.confirmedRequirement.length > 200
      ? state.confirmedRequirement.slice(0, 200) + '...'
      : state.confirmedRequirement
    parts.push(`需求已确认: ${preview}`)
  }

  if (state.designTasks?.length) {
    const completed = state.completedTaskIds.length
    const failed = state.failedTaskIds.length
    parts.push(`任务列表: ${state.designTasks.length}个, ${completed}完成, ${failed}失败`)
    for (const t of state.designTasks) {
      const status = state.completedTaskIds.includes(t.id) ? '[完成]'
        : state.failedTaskIds.includes(t.id) ? '[失败]' : '[待执行]'
      parts.push(`  ${status} ${t.id} [${t.changeType}] ${t.title} → ${t.file}`)
    }
    if (failed > 0) {
      const failedTasks = state.failedTaskIds.join(', ')
      parts.push(`失败任务: ${failedTasks}`)
    }
  }

  if (state.allowedPaths?.length) parts.push(`操作目录: ${state.allowedPaths[0]}`)

  return parts.join('\n') || '空闲状态，无进行中的任务'
}

// ── JSON Parsing ───────────────────────────────────────────────────

function extractJsonText(raw: string): string {
  const trimmed = raw.trim()
  const codeBlockStart = trimmed.indexOf('```json')
  if (codeBlockStart !== -1) {
    const afterMarker = trimmed.slice(codeBlockStart + 7)
    const codeBlockEnd = afterMarker.indexOf('```')
    if (codeBlockEnd !== -1) return afterMarker.slice(0, codeBlockEnd).trim()
    return afterMarker.trim()
  }
  const jsonStart = trimmed.indexOf('{')
  const jsonEnd = trimmed.lastIndexOf('}')
  if (jsonStart !== -1 && jsonEnd > jsonStart) return trimmed.slice(jsonStart, jsonEnd + 1)
  return trimmed
}

function parseAgentResult(raw: string): AgentResult | null {
  const jsonText = extractJsonText(raw)
  try {
    const obj = JSON.parse(jsonText)
    const action = obj.action
    if (action === 'chat') {
      return { action: 'chat', message: String(obj.message || raw.trim()) }
    }
    if (action === 'ask_user') {
      const questions = Array.isArray(obj.questions) ? obj.questions.map(String) : []
      if (questions.length === 0) return null
      return { action: 'ask_user', questions, message: obj.message ? String(obj.message) : undefined }
    }
    if (action === 'confirm') {
      const ct = obj.confirmType === 'design' ? 'design' : 'requirement'
      return { action: 'confirm', prompt: String(obj.prompt || ''), message: obj.message ? String(obj.message) : undefined, confirmType: ct }
    }
    if (action === 'done') {
      return { action: 'done', message: String(obj.message || '任务完成') }
    }
    return null
  } catch {
    try {
      let fixed = jsonText
      fixed = fixed.replace(/("thinking"\s*:\s*")([\s\S]*?)(")(?=\s*,\s*")/g, (_match, prefix, content) => {
        return prefix + content.replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'
      })
      const obj = JSON.parse(fixed)
      if (obj.action === 'chat') return { action: 'chat', message: String(obj.message || raw.trim()) }
      if (obj.action === 'ask_user') {
        const questions = Array.isArray(obj.questions) ? obj.questions.map(String) : []
        if (questions.length > 0) return { action: 'ask_user', questions }
      }
      if (obj.action === 'confirm') {
        const ct = obj.confirmType === 'design' ? 'design' : 'requirement'
        return { action: 'confirm', prompt: String(obj.prompt || ''), message: obj.message ? String(obj.message) : undefined, confirmType: ct }
      }
      if (obj.action === 'done') return { action: 'done', message: String(obj.message || '任务完成') }
    } catch {}
    return null
  }
}

// ── Agent ──────────────────────────────────────────────────────────

export class Agent {
  async run(
    sessionId: string,
    userInput: string,
    state: WorldState,
    signal?: AbortSignal,
    onEvent?: AgentEventHandler,
    onMetric?: MetricCallback,
    onConfirmWrite?: WriteConfirmFn,
  ): Promise<AgentResult> {
    const cfg = await loadModelConfig()
    const llm = createLlmClient(cfg, onMetric)
    const engine = await QueryEngine.load({ sessionId, llmClient: llm })

    const effectiveAllowedPaths = state.allowedPaths.length > 0 ? state.allowedPaths : [process.cwd()]
    const worldStateContext = buildWorldStateContext(state)

    // Load skills from markdown files
    const allSkills = await loadSkills(SKILLS_DIR)
    const activeSkills = getActiveSkills(allSkills, state)
    const activeSkillTexts = activeSkills.map((s) => s.content)

    const systemPrompt = buildSystemPrompt(effectiveAllowedPaths, worldStateContext, activeSkillTexts)

    // Inject/replace system prompt
    const hasCorrectPrompt = engine.state.messages.length > 0 && engine.state.messages[0].uuid === SYS_UUID
    if (!hasCorrectPrompt) {
      const sysMsg = { uuid: SYS_UUID, role: 'system' as const, content: systemPrompt, createdAt: Date.now() }
      if (engine.state.messages.length > 0 && engine.state.messages[0].role === 'system') {
        engine.state.messages[0] = sysMsg
      } else {
        engine.state.messages.unshift(sysMsg)
      }
    } else {
      engine.state.messages[0].content = systemPrompt
    }

    const tools = toolDefsToOpenAI('write')

    // Submit user message and enter tool call loop
    let fullText = ''
    let toolCalls: LlmToolCall[] = []

    try {
      for await (const evt of engine.submitMessage(userInput, { tools, signal })) {
      if (evt.kind === 'delta') {
        fullText += evt.delta
        await onEvent?.({ type: 'delta', text: evt.delta })
      }
      if (evt.kind === 'tool_calls') {
        toolCalls = evt.toolCalls
        for (const tc of toolCalls) {
          await onEvent?.({ type: 'tool_call', name: tc.name, arguments: tc.arguments })
        }
      }
    }

    // Tool call loop
    const toolFailureCounts = new Map<string, number>()

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      if (signal?.aborted) break
      if (toolCalls.length === 0) break

      for (const tc of toolCalls) {
        if (signal?.aborted) break
        let args: Record<string, string>
        try { args = JSON.parse(tc.arguments) } catch { continue }

        // 检查该工具+参数组合是否已失败超过上限
        const failureKey = `${tc.name}:${tc.arguments}`
        const failCount = toolFailureCounts.get(failureKey) ?? 0
        if (failCount >= MAX_TOOL_RETRIES) {
          await engine.appendToolResult(tc.id, tc.name, `错误：工具 "${tc.name}" 已连续失败 ${MAX_TOOL_RETRIES} 次，请换一种方式完成任务，不要再调用此工具。`)
          continue
        }

        const result = await executeTool(tc.name, args, effectiveAllowedPaths, 'write', state.designConfirmed, onConfirmWrite)
        await onEvent?.({ type: 'tool_result', name: tc.name, result })
        await engine.appendToolResult(tc.id, tc.name, result)

        // 记录失败
        if (result.startsWith('工具执行错误')) {
          toolFailureCounts.set(failureKey, failCount + 1)
        } else {
          toolFailureCounts.delete(failureKey)  // 成功则重置计数
        }
      }

      if (signal?.aborted) break
      fullText = ''
      toolCalls = []
      for await (const evt of engine.continueFromToolResults(tools, signal)) {
        if (evt.kind === 'delta') {
          fullText += evt.delta
          await onEvent?.({ type: 'delta', text: evt.delta })
        }
        if (evt.kind === 'tool_calls') {
          toolCalls = evt.toolCalls
          for (const tc of toolCalls) {
            await onEvent?.({ type: 'tool_call', name: tc.name, arguments: tc.arguments })
          }
        }
      }
    }

    // Abort check
    if (signal?.aborted) {
      return { action: 'chat', message: '[已中断] 操作被用户取消。' }
    }

    // 达到迭代上限 — 让 LLM 基于已有结果生成最终回答
    if (toolCalls.length > 0) {
      const prevText = fullText
      fullText = ''
      toolCalls = []
      try {
        for await (const evt of engine.submitMessage(
          `[系统提示] 你已达到 ${MAX_TOOL_ITERATIONS} 轮工具调用上限，请基于已获取的信息直接回答用户的问题。`,
          { tools: [], signal },
        )) {
          if (evt.kind === 'delta') fullText += evt.delta
        }
      } catch (err) {
        console.error('[Agent] 最终总结 LLM 调用失败:', err)
      }
      // 如果总结调用失败或为空，用之前累积的文字
      if (!fullText.trim() && prevText.trim()) {
        fullText = prevText
      }
    }

    // Parse final response
    if (!fullText.trim()) {
      return { action: 'chat', message: '(Agent 返回了空响应)' }
    }

    const parsed = parseAgentResult(fullText)
    if (parsed) return parsed

    return { action: 'chat', message: fullText.trim() }
    } catch (err) {
      if (signal?.aborted) {
        return { action: 'chat', message: '[已中断] 操作被用户取消。' }
      }
      throw err
    }
  }
}
