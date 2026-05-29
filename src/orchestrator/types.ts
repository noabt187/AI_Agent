import type { LlmToolCall } from '../llm/types.js'

export type WriteMode = 'auto' | 'batch' | 'per_file'

export type RequirementDocument = {
  title: string
  summary: string
  relatedFiles: string[]
  details: {
    target?: string
    location?: string
    appearance?: string
    behavior?: string
    data?: string
    constraints?: string
    [key: string]: string | string[] | undefined
  }
}

export type DesignTask = {
  id: string
  title: string
  description: string
  file: string
  changeType: 'create' | 'modify' | 'delete'
  dependencies: string[]
  rationale: string
}

export type WorldState = {
  sessionId: string
  allowedPaths: string[]
  writeMode: WriteMode

  // User intent
  goal?: string
  confirmedRequirement?: string
  requirementDocument?: RequirementDocument

  // Project context
  projectPath?: string

  // Task tracking
  designTasks?: DesignTask[]
  completedTaskIds: string[]
  failedTaskIds: string[]
  errors: Record<string, string>

  // Pending confirmation
  pendingConfirm?: { type: 'requirement' | 'design'; message: string }
}

export type AgentResult =
  | { action: 'chat'; message: string }
  | { action: 'ask_user'; questions: string[]; message?: string }
  | { action: 'confirm'; prompt: string; message?: string; confirmType?: 'requirement' | 'design' }
  | { action: 'done'; message: string }
