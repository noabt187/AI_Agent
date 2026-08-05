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

export type RepositoryConfig = {
  repoUrl?: string
  prRepoUrl?: string
  upstreamUrl?: string
  defaultBaseBranch?: string
  githubLogin?: string
  gitUserName?: string
  gitUserEmail?: string
}

export type ConfirmationScope = 'workspace_write' | 'remote_git' | 'destructive_revert'

export type AuthorizationState = {
  scope: ConfirmationScope
  taskId: string
  authorizationId: number
}

export function isMemoryRecallMode(value: unknown): value is MemoryRecallMode {
  return value === 'auto' || value === 'off' || value === 'on'
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function normalizeRepositoryConfig(config?: Partial<RepositoryConfig>): RepositoryConfig {
  return {
    repoUrl: optionalString(config?.repoUrl),
    prRepoUrl: optionalString(config?.prRepoUrl),
    upstreamUrl: optionalString(config?.upstreamUrl),
    defaultBaseBranch: optionalString(config?.defaultBaseBranch),
    githubLogin: optionalString(config?.githubLogin),
    gitUserName: optionalString(config?.gitUserName),
    gitUserEmail: optionalString(config?.gitUserEmail),
  }
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
  repository?: RepositoryConfig

  // User intent
  goal?: string
  confirmedRequirement?: string

  // Task tracking
  designTasks?: DesignTask[]
  completedTaskIds: string[]
  failedTaskIds: string[]
  activeTaskId?: string
  authorizationCounter?: number
  authorization?: AuthorizationState

  // Pending confirmation
  pendingConfirm?: {
    allowWrite: boolean
    message: string
    scope?: ConfirmationScope
  }

  // Write gate: true = user confirmed design, writes allowed
  designConfirmed?: boolean
}

export type AgentResult =
  | { action: 'chat'; message: string; taskComplete?: boolean }
  | { action: 'ask_user'; questions: string[]; message?: string }
  | {
      action: 'confirm'
      prompt: string
      message?: string
      confirmType?: 'allow_write'
      confirmScope?: ConfirmationScope
    }
  | { action: 'done'; message: string }

export type AgentEvent =
  | { type: 'output'; message: string }
  | { type: 'delta'; text: string }
  | { type: 'retry'; attempt: number; maxAttempts: number; reason: string; delayMs: number }
  | { type: 'protocol_fallback'; action: AgentResult['action'] }
  | { type: 'protocol_violation'; message: string }
  | { type: 'tool_call'; name: string; arguments: string }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'result'; result: AgentResult }
  | { type: 'aborted'; message: string }
  | { type: 'error'; message: string }

export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>
