export type ToolResultCode =
  | 'OK'
  | 'UNKNOWN_TOOL'
  | 'INVALID_ARGUMENTS'
  | 'PATH_OUTSIDE_ALLOWED'
  | 'PERMISSION_DENIED'
  | 'COMMAND_NOT_FOUND'
  | 'COMMAND_FAILED'
  | 'TIMEOUT'
  | 'REMOTE_SIDE_EFFECT_BLOCKED'
  | 'TOOL_EXECUTION_FAILED'
  | 'RETRY_EXHAUSTED'
  | 'ABORTED'
  | 'OUTPUT_LIMIT'

export type ToolResult = {
  ok: boolean
  code: ToolResultCode
  message: string
  retryable: boolean
  data?: Record<string, unknown>
}

export function toolSuccess(message: string, data?: Record<string, unknown>): ToolResult {
  return data === undefined
    ? { ok: true, code: 'OK', message, retryable: false }
    : { ok: true, code: 'OK', message, retryable: false, data }
}

export function toolFailure(
  code: Exclude<ToolResultCode, 'OK'>,
  message: string,
  retryable = false,
  data?: Record<string, unknown>,
): ToolResult {
  return data === undefined
    ? { ok: false, code, message, retryable }
    : { ok: false, code, message, retryable, data }
}

export function serializeToolResult(result: ToolResult): string {
  return JSON.stringify(result)
}

/** Legacy/plugin tools keep their text contract; the execution layer owns status. */
export function toolResultFromLegacyOutput(raw: string): ToolResult {
  if (/^❌\s*验证未通过/.test(raw.trim())) {
    return toolFailure('COMMAND_FAILED', raw, false, { output: raw })
  }
  if (/^(错误|工具执行错误)/.test(raw.trim())) {
    const commandMissing = /(?:spawn\s+\S+\s+ENOENT|command not found|不是内部或外部命令)/i.test(raw)
    return toolFailure(commandMissing ? 'COMMAND_NOT_FOUND' : 'TOOL_EXECUTION_FAILED', raw, false, { output: raw })
  }
  return toolSuccess(raw, { output: raw })
}

export function toolResultToLegacyOutput(result: ToolResult): string {
  return result.ok || /^(错误|工具执行错误|❌)/.test(result.message.trim())
    ? result.message : `错误：${result.message}`
}
