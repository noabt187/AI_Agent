import type { AgentEvent, AgentResult } from '../src/orchestrator/types.js'

export type EvalTaskKind = 'read' | 'write' | 'clarify' | 'permission'

export type EvalTask = {
  id: string
  title: string
  kind: EvalTaskKind
  prompt: string
  fixture: Record<string, string>
  expectedTools: string[]
  allowedChanges: string[]
  autoConfirm: boolean
  memory?: {
    name: string
    description: string
    body: string
  }
}

export type ToolCallTrace = {
  name: string
  arguments: string
  parsedArguments?: Record<string, unknown>
  argumentJsonValid: boolean
  beforeWriteAuthorization: boolean
  result?: string
  resultIsError?: boolean
}

export type TrialMetrics = {
  llmCallCount: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  averageLatencyMs: number
  averageFirstTokenMs: number
  durationMs: number
  toolCallCount: number
  providerRetryCount: number
  nativeControlActionCount: number
  protocolFallbackCount: number
  protocolViolationCount: number
}

export type GradeResult = {
  outcomePassed: boolean
  safetyPassed: boolean
  passed: boolean
  assertions: Array<{ name: string; passed: boolean; detail: string }>
  changedFiles: string[]
  permissionViolation: boolean
  outOfScopeChanges: string[]
  errorOccurred: boolean
  recoveredFromError: boolean
  relevantToolCalls: number
  validArgumentCalls: number
}

export type TrialRecord = {
  trialId: string
  taskId: string
  taskTitle: string
  repetition: number
  startedAt: string
  workspace: string
  model: string
  status: 'passed' | 'failed' | 'invalid' | 'infrastructure_error'
  finalResult?: AgentResult
  events: AgentEvent[]
  toolCalls: ToolCallTrace[]
  metrics: TrialMetrics
  grade?: GradeResult
  error?: string
}

export type ContractCaseResult = {
  id: string
  category: 'schema' | 'argument' | 'permission' | 'isolation' | 'execution'
  passed: boolean
  detail: string
}

export type EvalSummary = {
  generatedAt: string
  gitCommit: string
  model: string
  taskCount: number
  trialCount: number
  validTrialCount: number
  passedTrials: number
  passAt1: { numerator: number; denominator: number; value: number }
  passPower3: { numerator: number; denominator: number; value: number }
  hiddenOutcomeRate: { numerator: number; denominator: number; value: number }
  permissionViolationRate: { numerator: number; denominator: number; value: number }
  outOfScopeChangeRate: { numerator: number; denominator: number; value: number }
  argumentValidityRate: { numerator: number; denominator: number; value: number }
  toolSelectionPrecision: { numerator: number; denominator: number; value: number }
  errorRecoveryRate: { numerator: number; denominator: number; value: number }
  nativeControlActionRate: { numerator: number; denominator: number; value: number }
  protocolFallbackRate: { numerator: number; denominator: number; value: number }
  protocolViolationRate: { numerator: number; denominator: number; value: number }
  providerRetryRate: { numerator: number; denominator: number; value: number }
  verificationExecutionRate: { numerator: number; denominator: number; value: number }
  checkpointFailureRate: { numerator: number; denominator: number; value: number }
  medianLlmCalls: number
  medianToolCalls: number
  medianTotalTokens: number
  medianDurationMs: number
  contract: {
    passed: number
    total: number
    rate: number
  }
}
