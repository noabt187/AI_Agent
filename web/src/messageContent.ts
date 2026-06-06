import type { Message } from './api'

type AgentDisplayPayload = {
  message?: unknown
  prompt?: unknown
}

const agentPayloadKeys = ['thinking', 'action', 'message', 'prompt', 'questions', 'confirmType']

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

function isLikelyAgentPayload(raw: string): boolean {
  return /"action"\s*:/.test(raw) && (/"thinking"\s*:/.test(raw) || /"message"\s*:/.test(raw) || /"prompt"\s*:/.test(raw))
}

function decodeLooseJsonString(value: string): string {
  try {
    return JSON.parse(`"${value.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`) as string
  } catch {
    return value
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\')
  }
}

function extractLooseJsonStringField(raw: string, fieldName: string): string | undefined {
  const fieldPattern = new RegExp(`"${fieldName}"\\s*:\\s*"`)
  const match = fieldPattern.exec(raw)
  if (!match) return undefined

  const valueStart = match.index + match[0].length
  for (let index = valueStart; index < raw.length; index += 1) {
    if (raw[index] !== '"') continue

    let backslashCount = 0
    for (let cursor = index - 1; cursor >= valueStart && raw[cursor] === '\\'; cursor -= 1) {
      backslashCount += 1
    }
    if (backslashCount % 2 === 1) continue

    const rest = raw.slice(index + 1).trimStart()
    const closesObject = rest.startsWith('}')
    const nextField = agentPayloadKeys.some((key) => rest.startsWith(`,"${key}"`) || rest.match(new RegExp(`^,\\s*"${key}"\\s*:`)))
    if (closesObject || nextField) return decodeLooseJsonString(raw.slice(valueStart, index))
  }

  return undefined
}

function normalizeAgentDisplayPayload(payload: AgentDisplayPayload, fallbackRaw: string): string {
  const parts = [payload.message, payload.prompt]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)

  if (parts.length > 0) return parts.join('\n\n')
  return isLikelyAgentPayload(fallbackRaw) ? '' : fallbackRaw
}

function parseAgentDisplayPayload(raw: string): string | undefined {
  const jsonText = extractJsonText(raw)
  try {
    const parsed = JSON.parse(jsonText) as AgentDisplayPayload
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return normalizeAgentDisplayPayload(parsed, jsonText)
    }
  } catch {}

  const loosePayload = {
    message: extractLooseJsonStringField(jsonText, 'message'),
    prompt: extractLooseJsonStringField(jsonText, 'prompt'),
  }
  if (loosePayload.message !== undefined || loosePayload.prompt !== undefined || isLikelyAgentPayload(jsonText)) {
    return normalizeAgentDisplayPayload(loosePayload, jsonText)
  }

  return undefined
}

export function messageContent(message: Pick<Message, 'role' | 'content'>): string {
  if (message.role !== 'assistant') return message.content
  return parseAgentDisplayPayload(message.content) ?? message.content
}
