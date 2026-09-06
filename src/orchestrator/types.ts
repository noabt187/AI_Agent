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
  schemaVersion?: 2
  task?: TaskState
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

  // Pending confirmation
  pendingConfirm?: { allowWrite: boolean; message: string }

  // Write gate: true = user confirmed design, writes allowed
  designConfirmed?: boolean
}

export type AgentResult =
  | { action: 'chat'; message: string }
  | { action: 'ask_user'; questions: string[]; message?: string }
  | { action: 'confirm'; prompt: string; message?: string; confirmType?: 'allow_write'; selections?: string[] }
  | { action: 'done'; message: string }

export type AgentEvent =
  | { type: 'task'; runId: string; task: TaskState }
  | { type: 'run'; run: import('../state/runStore.js').RunRecord }
  | { type: 'output'; message: string }
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; name: string; arguments: string }
  | { type: 'tool_result'; name: string; result: string }
  | { type: 'result'; result: AgentResult }
  | { type: 'aborted'; message: string }
  | { type: 'error'; message: string; recoverable?: boolean }

export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>

export interface ConfirmationRef { taskId: string; taskRevision: number; confirmationId: string }
export type TaskInputControl =
  | ({ kind: 'confirm'; selection?: string } & ConfirmationRef)
  | ({ kind: 'revise' } & ConfirmationRef)
  | { kind: 'resume'; taskId: string; taskRevision: number }
export interface TaskRequestBinding {
  runId: string
  userMessageId: string
  input: string
  workspaceKey: string
  control?: TaskInputControl
}
export interface TurnContext extends TaskRequestBinding {
  readonly runId: string
  readonly userMessageId: string
  readonly input: string
  readonly workspaceKey: string
  readonly control?: TaskInputControl
  readonly taskId: string
  readonly taskRevision: number
  readonly intent: 'new' | 'revise' | 'confirm' | 'resume' | 'cancel'
  readonly allowedPaths: string[]
  readonly repository: RepositoryConfig
}
export interface PendingConfirmation extends ConfirmationRef {
  id: string
  kind: 'allow_write' | 'read_only'
  allowWrite: boolean
  message: string
  prompt: string
  selections?: string[]
  sourceRunId: string
}
export interface WriteApproval extends ConfirmationRef { workspaceKey: string }
export interface ApprovedProposal extends PendingConfirmation {
  selection?: string
}
export interface TaskBackground {
  objective: string
  requirement?: string
  proposal?: string
  questions?: string[]
}
export interface TaskState {
  id: string
  revision: number
  objective: string
  phase: 'active' | 'awaiting_input' | 'awaiting_confirmation' | 'paused' | 'completed' | 'cancelled'
  previousContext: TaskBackground[]
  completedTaskIds: string[]
  failedTaskIds: string[]
  designTasks?: DesignTask[]
  questions?: string[]
  pendingConfirmation?: PendingConfirmation
  approval?: WriteApproval
  approvedProposal?: ApprovedProposal
  lastRunId?: string
  interruption?: string
}
