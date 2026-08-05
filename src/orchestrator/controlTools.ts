import type { LlmToolCall, ToolDefinition } from '../llm/types.js'
import type { AgentResult, ConfirmationScope } from './types.js'

const CONFIRMATION_SCOPES: ConfirmationScope[] = [
  'workspace_write',
  'remote_git',
  'destructive_revert',
]

export const CONTROL_TOOL_NAMES = new Set([
  'request_confirmation',
  'ask_user',
  'finish',
])

export const CONTROL_TOOL_DEFS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'request_confirmation',
      description: '结束当前轮并请求用户授权后续操作。需要修改文件、执行本地验证、操作远程 Git 或执行破坏性回退时使用。',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: '已完成的分析和拟执行方案' },
          prompt: { type: 'string', description: '请用户确认的具体问题' },
          scope: {
            type: 'string',
            description: '申请的权限范围',
            enum: CONFIRMATION_SCOPES,
          },
        },
        required: ['message', 'prompt', 'scope'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: '结束当前轮并向用户询问缺失且无法从当前项目确定的信息。',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: '可选的询问背景' },
          questions: {
            type: 'array',
            description: '需要用户回答的问题列表',
            items: { type: 'string' },
          },
        },
        required: ['questions'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: '结束当前任务并向用户返回最终结果。只读回答使用 answered，完成修改使用 completed。',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: '最终回复' },
          outcome: {
            type: 'string',
            description: '任务结束类型',
            enum: ['answered', 'completed'],
          },
        },
        required: ['message', 'outcome'],
      },
    },
  },
]

type ParsedControl = {
  result?: AgentResult
  error?: string
}

function parseArguments(call: LlmToolCall): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(call.arguments)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function parseControlToolCall(call: LlmToolCall): ParsedControl {
  if (!CONTROL_TOOL_NAMES.has(call.name)) return { error: `未知控制工具 "${call.name}"` }
  const args = parseArguments(call)
  if (!args) return { error: `控制工具 "${call.name}" 参数不是合法 JSON 对象` }

  if (call.name === 'request_confirmation') {
    const message = typeof args.message === 'string' ? args.message.trim() : ''
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    const scope = typeof args.scope === 'string' && CONFIRMATION_SCOPES.includes(args.scope as ConfirmationScope)
      ? args.scope as ConfirmationScope
      : undefined
    if (!message || !prompt || !scope) {
      return { error: 'request_confirmation 缺少 message、prompt 或合法 scope' }
    }
    return {
      result: {
        action: 'confirm',
        message,
        prompt,
        confirmType: 'allow_write',
        confirmScope: scope,
      },
    }
  }

  if (call.name === 'ask_user') {
    const questions = Array.isArray(args.questions)
      ? args.questions.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : []
    if (questions.length === 0) return { error: 'ask_user.questions 至少包含一个非空问题' }
    return {
      result: {
        action: 'ask_user',
        questions: questions.map((item) => item.trim()),
        message: typeof args.message === 'string' && args.message.trim() ? args.message.trim() : undefined,
      },
    }
  }

  const message = typeof args.message === 'string' ? args.message.trim() : ''
  const outcome = args.outcome
  if (!message || (outcome !== 'answered' && outcome !== 'completed')) {
    return { error: 'finish 缺少 message 或合法 outcome' }
  }
  return outcome === 'completed'
    ? { result: { action: 'done', message } }
    : { result: { action: 'chat', message, taskComplete: true } }
}
