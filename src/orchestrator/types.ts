export type DesignTask = {
  id: string
  title: string
  description: string
  file: string
  changeType: 'create' | 'modify' | 'delete'
  dependencies: string[]
  rationale: string
}

export type MemoryRecallMode = 'auto' | 'off' | 'on'

export type MemorySettings = {
  recallMode: MemoryRecallMode
}

export function isMemoryRecallMode(value: unknown): value is MemoryRecallMode {
  return value === 'auto' || value === 'off' || value === 'on'
}

export function normalizeMemorySettings(settings?: Partial<MemorySettings>): MemorySettings {
  return {
    recallMode: isMemoryRecallMode(settings?.recallMode) ? settings.recallMode : 'auto',
  }
}

export function getMemorySettings(state: { memorySettings?: Partial<MemorySettings> }): MemorySettings {
  return normalizeMemorySettings(state.memorySettings)
}

export type WorldState = {
  sessionId: string
  allowedPaths: string[]
  memorySettings?: MemorySettings
  workflow?: {
    node?: string
  }

  // User intent
  goal?: string
  confirmedRequirement?: string

  // Task tracking
  designTasks?: DesignTask[]
  completedTaskIds: string[]
  failedTaskIds: string[]
  errors: Record<string, string>

  // Pending confirmation
  pendingConfirm?: {
    allowWrite: boolean
    message: string
    workflow?: {
      currentNode: string
      nextNode: string
    }
  }

  // Write gate: true = user confirmed design, writes allowed
  designConfirmed?: boolean
}

export type AgentResult =
  | { action: 'chat'; message: string }
  | { action: 'ask_user'; questions: string[]; message?: string }
  | { action: 'confirm'; prompt: string; message?: string; confirmType?: 'allow_write' }
  | { action: 'done'; message: string }

export type AgentEvent =
  | { type: 'output'; message: string }
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; name: string; arguments: string }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'result'; result: AgentResult }
  | { type: 'error'; message: string }

export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>
