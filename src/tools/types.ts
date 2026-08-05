export type ToolResultCode =
  | 'OK'
  | 'UNKNOWN_TOOL'
  | 'INVALID_ARGUMENTS'
  | 'PATH_OUTSIDE_ALLOWED'
  | 'PERMISSION_DENIED'
  | 'CHECKPOINT_FAILED'
  | 'COMMAND_NOT_FOUND'
  | 'COMMAND_FAILED'
  | 'TIMEOUT'
  | 'REMOTE_SIDE_EFFECT_BLOCKED'
  | 'TOOL_EXECUTION_FAILED'
  | 'RETRY_EXHAUSTED'

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
