import { resolve } from 'node:path'
import { QueryEngine } from '../QueryEngine.js'
import { createLlmClient } from '../llm/index.js'
import type { MetricCallback } from '../llm/index.js'
import { loadModelConfig } from '../context/modelConfig.js'
import { executeTool, toolDefsToOpenAI } from '../tools/index.js'
import { getSkillCatalog, loadSkills, useSkill, type Skill } from '../skills/index.js'
import {
  extractMemoryTerms,
  formatMemoryContext,
} from '../memory/projectMemory.js'
import type { AgentEventHandler, AgentResult, WorldState } from './types.js'
import { getMemorySettings } from './types.js'
import type { LlmToolCall, ToolDefinition } from '../llm/types.js'

const MAX_TOOL_ITERATIONS = 30
const MAX_TOOL_RETRIES = 3
const SYS_UUID = 'agent-sys-001'

const SKILLS_DIR = resolve(import.meta.dirname ?? process.cwd(), '../skills')

const USE_SKILL_TOOL_DEF: ToolDefinition = {
  type: 'function',
  function: {
    name: 'use_skill',
    description: '加载指定技能的完整指引内容。调用后返回该技能的详细操作步骤和规则。根据当前任务类型选择合适的技能加载。',
    parameters: {
      type: 'object',
      properties: {
        skillName: { type: 'string', description: '要加载的技能名称' },
      },
      required: ['skillName'],
    },
  },
}

const SYSTEM_PROMPT = `你是全栈开发助手。通过读取代码、分析需求、设计方案、编写代码来帮助用户完成开发任务。

## 工作方式
你通过"观察→思考→行动"循环工作：
1. 观察：理解用户说了什么、之前做了什么、项目状态如何
2. 思考：决定下一步做什么
3. 行动：调用工具读取/写入代码，或回复用户

当你需要调用工具时，使用工具调用功能（不要在文本中输出工具调用格式）。
工具调用中的文件路径参数（如 filePath、dirPath）必须使用绝对路径，且必须位于当前可操作目录之下。
当你准备好回复用户时，输出以下 JSON 格式。

根据任务需要选择合适的流程，不要总是固定步骤：
- **简单修改**（改文案、修小bug）：读代码 → confirm(allow_write) 呈现具体修改 → 确认 → 写代码 → done
- **复杂功能**（新功能、跨文件重构）：读代码 → confirm() 对齐需求 → 确认 → confirm(allow_write) 呈现任务列表 → 确认 → 写代码 → done
- **纯分析**（审查代码、回答问题）：读代码 → chat 直接回答
- **副作用操作**（fork、clone、PR）：confirm(allow_write) 确认参数后执行

**重要规则**：
- 用户确认前不要调用写工具。写工具包括 writeFile、deleteFile、createPullRequest、forkRepository、cloneRepository。这些工具会修改文件或操作远程仓库，必须先输出 action: confirm, confirmType: allow_write 并等待用户确认后才能调用。
- confirmType="allow_write" 表示确认后将执行写操作（修改/删除文件、创建 PR、fork/clone 仓库）
- 仅在对齐理解、确认需求时，省略 confirmType
- 当前状态、Markdown 记忆、相关历史经验和阶段技能会作为本轮临时上下文提供；这些内容只用于本轮判断，不要把它们写入会话历史。
- 相关历史经验不代表当前代码事实，涉及文件、接口、组件状态时必须读取当前 repo 确认。

## 输出格式
当你要回复用户时（不调用工具时），只输出 JSON，不要输出其他内容：
{"thinking":"你的分析思路","action":"chat|ask_user|confirm|done","message":"给用户的消息","questions":["问题1"],"prompt":"确认内容","confirmType":"allow_write"}
JSON 字符串涉及到引号文本，使用///"来转义引号，避免 JSON 错误解析。

action 说明：
- chat：直接回复用户（普通对话、回答问题）
- ask_user：需要用户提供更多信息，questions 数组不能为空
- confirm：需要用户确认当前内容后再继续，prompt 为确认内容
  - confirmType="allow_write"：确认后需要修改文件（调用 writeFile/deleteFile），**仅在确认后需要写文件时设置**
  - 如果确认后只是继续分析、设计方案，不需要修改文件，**省略 confirmType 字段**
- done：任务完成，message 为完成总结
## Auto memory
When durable long-term memory is worth saving, first call use_skill("auto-memory"), then follow that skill before calling writeMemory. Do not return memories in the final JSON. Skip memory writing for temporary task progress, generic summaries, repo facts, or anything already recorded in code or git history.
`

export function buildWorldStateContext(state: WorldState): string {
  const parts: string[] = []

  if (state.goal) parts.push(`用户目标: ${state.goal}`)
  if (state.confirmedRequirement) {
    const preview = state.confirmedRequirement.length > 1500
      ? `${state.confirmedRequirement.slice(0, 1500)}...`
      : state.confirmedRequirement
    parts.push(`需求已确认: ${preview}`)
  }
  if (state.pendingConfirm) {
    const pendingPreview = state.pendingConfirm.message.length > 1200
      ? `${state.pendingConfirm.message.slice(0, 1200)}...`
      : state.pendingConfirm.message
    parts.push(`待确认内容: [${state.pendingConfirm.allowWrite ? 'allow_write' : 'read_only'}] ${pendingPreview}`)
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
    if (failed > 0) parts.push(`失败任务: ${state.failedTaskIds.join(', ')}`)
  }

  if (state.allowedPaths?.length) {
    parts.push(`可操作目录:\n${state.allowedPaths.map((path) => `- ${path}`).join('\n')}`)
  }

  if (state.repository) {
    const repoLines = [
      state.repository.repoUrl ? `- repoUrl: ${state.repository.repoUrl}` : '',
      state.repository.prRepoUrl ? `- prRepoUrl: ${state.repository.prRepoUrl}` : '',
      state.repository.upstreamUrl ? `- upstreamUrl: ${state.repository.upstreamUrl}` : '',
      state.repository.defaultBaseBranch ? `- defaultBaseBranch: ${state.repository.defaultBaseBranch}` : '',
    ].filter(Boolean)
    if (repoLines.length > 0) {
      parts.push(`仓库配置:\n${repoLines.join('\n')}`)
    }
  }

  if (state.designConfirmed) parts.push('写权限: 已开放（可调用 writeFile、deleteFile、createPullRequest、forkRepository、cloneRepository）')
  else if (state.designTasks?.length) parts.push('写权限: 未开放（需用户确认 allow_write 后才可调用写工具）')

  return parts.join('\n') || '空闲状态，无进行中的任务'
}

export function buildRuntimeContext(
  state: WorldState,
  memoryContext: string,
  allSkills: Skill[],
): string {
  const parts = [`## 当前状态\n${buildWorldStateContext(state)}`]
  if (memoryContext.trim()) {
    parts.push(`## Memory\n${memoryContext.trim()}`)
  }

  // Skill catalog — always show compact listing
  const catalog = getSkillCatalog(allSkills)
  if (catalog) {
    parts.push(`## 可用技能 (Skills)\n${catalog}\n\n根据任务需要调用 use_skill(skillName) 加载完整技能指引。`)
  }

  return parts.join('\n\n')
}

function abortedResult(signal?: AbortSignal): AgentResult | null {
  if (signal?.aborted) {
    return { action: 'chat', message: '[已中断] 操作被用户取消。' }
  }
  return null
}

export function isPureConfirmationInput(input: string): boolean {
  const trimmed = input.trim().toLowerCase()
  return trimmed === '确认' || trimmed === '是' || trimmed === 'yes' || trimmed === 'y'
    || trimmed === 'ok' || trimmed === '好' || trimmed === '可以' || trimmed === '开始'
    || trimmed === '确认方案' || trimmed === '开始写' || trimmed === '开始编写'
}

export function shouldRecallTaskMemories(state: WorldState, userInput: string): boolean {
  const mode = getMemorySettings(state).recallMode
  if (mode === 'off') return false
  if (mode === 'on') return true
  if (isPureConfirmationInput(userInput)) return false
  return !state.pendingConfirm && !state.confirmedRequirement && !state.designConfirmed
}

export function buildTaskMemorySearchQuery(state: WorldState, userInput: string): string {
  const trimmed = userInput.trim()
  const userTerms = extractMemoryTerms(trimmed)
  if (isPureConfirmationInput(trimmed) || userTerms.length === 0) {
    return (state.confirmedRequirement || state.goal || trimmed).trim()
  }

  const parts: string[] = []
  if (state.goal && state.goal.trim() !== trimmed) parts.push(state.goal)
  parts.push(trimmed)
  return parts.join('\n').trim()
}

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

function isToolOperationConfirmationText(text: string): boolean {
  return /\bpr\b|pull request|createPullRequest|提交\s*pr|创建\s*pr|发起\s*pr|PR\s*参数|PR\s*标题|PR\s*目标仓库/i.test(text)
    || /forkRepository|cloneRepository|Fork\s*参数|Clone\s*参数|克隆\s*参数|源仓库|目标账号|目标组织|fork\s*名|clone\s*目录|本地目标目录/i.test(text)
}

function normalizeConfirmType(confirmType: 'allow_write' | undefined, text: string): 'allow_write' | undefined {
  if (!confirmType && isToolOperationConfirmationText(text)) return 'allow_write'
  return confirmType
}

function parseToolOperationMarkdownConfirm(raw: string): AgentResult | null {
  const text = raw.trim()
  if (!text || !isToolOperationConfirmationText(text)) return null
  if (!/请确认|确认以上|确认执行|是否正确|是否以上述|是否使用/.test(text)) return null
  return {
    action: 'confirm',
    confirmType: 'allow_write',
    prompt: text,
    message: text,
  }
}

function agentResultFromParsed(obj: Record<string, unknown>, fallbackText: string): AgentResult | null {
  const action = obj.action
  if (action === 'chat') return { action: 'chat', message: String(obj.message || fallbackText) }
  if (action === 'ask_user') {
    const questions = Array.isArray(obj.questions) ? obj.questions.map(String) : []
    if (questions.length === 0) return null
    return { action: 'ask_user', questions, message: obj.message ? String(obj.message) : undefined }
  }
  if (action === 'confirm') {
    const prompt = String(obj.prompt || '')
    const message = obj.message ? String(obj.message) : undefined
    // 'design' is legacy alias for 'allow_write'
    const explicit = (obj.confirmType === 'allow_write' || obj.confirmType === 'design') ? 'allow_write' : undefined
    const ct = normalizeConfirmType(explicit, `${message ?? ''}\n${prompt}`)
    return { action: 'confirm', prompt, message, confirmType: ct }
  }
  if (action === 'done') return { action: 'done', message: String(obj.message || '任务完成') }
  return null
}

export function parseAgentResult(raw: string): AgentResult | null {
  const jsonText = extractJsonText(raw)
  try {
    return agentResultFromParsed(JSON.parse(jsonText), raw.trim())
  } catch {
    try {
      let fixed = jsonText
      fixed = fixed.replace(/("thinking"\s*:\s*")([\s\S]*?)(")(?=\s*,\s*")/g, (_match, prefix, content) => {
        return prefix + content.replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'
      })
      return agentResultFromParsed(JSON.parse(fixed), raw.trim())
    } catch {}
    return parseToolOperationMarkdownConfirm(raw)
  }
}

export class Agent {
  async run(
    sessionId: string,
    userInput: string,
    state: WorldState,
    signal?: AbortSignal,
    onEvent?: AgentEventHandler,
    onMetric?: MetricCallback,
  ): Promise<AgentResult> {
    const cfg = await loadModelConfig()
    const llm = createLlmClient(cfg, onMetric)
    const engine = await QueryEngine.load({ sessionId, llmClient: llm })

    const effectiveAllowedPaths = state.allowedPaths.length > 0 ? state.allowedPaths : [process.cwd()]
    const allSkills = await loadSkills(SKILLS_DIR)
    const taskMemoryQuery = buildTaskMemorySearchQuery(state, userInput)
    const memoryContext = shouldRecallTaskMemories(state, userInput)
      ? await formatMemoryContext({
        projectDir: effectiveAllowedPaths[0],
        sessionId,
        query: taskMemoryQuery,
        includeAllIndexes: true,
      })
      : ''

    const systemPrompt = SYSTEM_PROMPT
    const runtimeContext = buildRuntimeContext(state, memoryContext, allSkills)
    const turnLoadedSkills = new Set<string>()

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

    const tools = [...toolDefsToOpenAI('write'), USE_SKILL_TOOL_DEF]
    let fullText = ''
    let toolCalls: LlmToolCall[] = []

    // Helper: consume stream events, accumulating text and tool calls
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const consumeStream = async (stream: AsyncIterable<any>): Promise<void> => {
      for await (const evt of stream) {
        if (signal?.aborted) break
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

    try {
      await consumeStream(engine.submitMessage(userInput, { tools, signal, runtimeContext }))

      const abortRet = abortedResult(signal)
      if (abortRet) return abortRet

      const toolFailureCounts = new Map<string, number>()

      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        if (signal?.aborted) break
        if (toolCalls.length === 0) break

        for (const tc of toolCalls) {
          if (signal?.aborted) break
          let args: Record<string, string>
          try { args = JSON.parse(tc.arguments) } catch { continue }

          // ── Virtual tool: use_skill ──
          if (tc.name === 'use_skill') {
            const skillName = args.skillName?.trim()
            if (!skillName) {
              await engine.appendToolResult(tc.id, 'use_skill', '错误：缺少 skillName 参数')
              continue
            }
            const skillContent = useSkill(allSkills, skillName)
            if (skillContent) {
              turnLoadedSkills.add(skillName)
              await engine.appendToolResult(tc.id, 'use_skill', skillContent)
              await onEvent?.({ type: 'tool_result', name: 'use_skill', result: skillContent })
            } else {
              const available = allSkills.map((s) => s.name).join(', ')
              await engine.appendToolResult(tc.id, 'use_skill', `错误：未找到技能 "${skillName}"。可用技能: ${available}`)
            }
            continue
          }

          const failureKey = `${tc.name}:${tc.arguments}`
          const failCount = toolFailureCounts.get(failureKey) ?? 0
          if (failCount >= MAX_TOOL_RETRIES) {
            await engine.appendToolResult(tc.id, tc.name, `错误：工具 "${tc.name}" 已连续失败 ${MAX_TOOL_RETRIES} 次，请换一种方式完成任务，不要再调用此工具。`)
            continue
          }

          if (signal?.aborted) break
          const result = await executeTool(
            tc.name,
            args,
            effectiveAllowedPaths,
            state.designConfirmed,
            signal,
            { turnLoadedSkills, repository: state.repository },
          )
          await onEvent?.({ type: 'tool_result', name: tc.name, result })
          await engine.appendToolResult(tc.id, tc.name, result)

          if (result.startsWith('工具执行错误')) {
            toolFailureCounts.set(failureKey, failCount + 1)
          } else {
            toolFailureCounts.delete(failureKey)
          }
        }

        if (signal?.aborted) break
        fullText = ''
        toolCalls = []
        await consumeStream(engine.continueFromToolResults(tools, signal, runtimeContext))
      }

      const a = abortedResult(signal)
      if (a) return a

      if (toolCalls.length > 0) {
        const prevText = fullText
        fullText = ''
        toolCalls = []
        try {
          for await (const evt of engine.submitMessage(
            `[系统提示] 你已达到 ${MAX_TOOL_ITERATIONS} 轮工具调用上限，请基于已获取的信息直接回答用户的问题。`,
            { tools: [], signal, runtimeContext },
          )) {
            if (evt.kind === 'delta') fullText += evt.delta
          }
        } catch (err) {
          console.error('[Agent] 最终总结 LLM 调用失败:', err)
        }
        if (!fullText.trim() && prevText.trim()) {
          fullText = prevText
        }
      }

      if (!fullText.trim()) {
        return { action: 'chat', message: '(Agent 返回了空响应)' }
      }

      const parsed = parseAgentResult(fullText)
      if (parsed) return parsed

      return { action: 'chat', message: fullText.trim() }
    } catch (err) {
      const a = abortedResult(signal)
      if (a) return a
      throw err
    }
  }
}
