export const EXPERIMENT_STORAGE_KEY = 'dsh-experiment-metrics:v1'
export const EXPERIMENT_SCHEMA_VERSION = 1

export interface TokenUsage {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

export type ArmOutcome = 'pending' | 'passed' | 'failed'

export interface ExperimentArm {
  sessionId: string
  startUsage?: TokenUsage
  endUsage?: TokenUsage
  startedAt?: number
  endedAt?: number
  outcome: ArmOutcome
  turns: number
  clarifications: number
  reworks: number
  notes: string
}

export interface Experiment {
  id: string
  title: string
  task: string
  baseCommit: string
  model: string
  acceptanceCriteria: string
  control: ExperimentArm
  pagecraft: ExperimentArm
  createdAt: number
  updatedAt: number
}

export interface ArmMetrics {
  usage?: TokenUsage
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export interface ExperimentComparison {
  kind: 'incomplete' | 'not-comparable' | 'comparable'
  control: ArmMetrics
  pagecraft: ArmMetrics
  savedTokens?: number
  savingRate?: number
  reason?: string
}

export interface AggregateMetrics {
  experimentCount: number
  comparableCount: number
  controlPassed: number
  pagecraftPassed: number
  medianSavingRate?: number
  totalSavedTokens: number
}

interface StoredExperiments {
  version: 1
  experiments: Experiment[]
}

const tokenKeys = [
  'uncachedInputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
] as const

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined
}

export function normalizeTokenUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const entries = tokenKeys.map(key => finiteNonNegative(record[key]))
  if (entries.some(item => item === undefined)) return undefined
  return {
    uncachedInputTokens: entries[0]!,
    cacheReadTokens: entries[1]!,
    cacheWriteTokens: entries[2]!,
    outputTokens: entries[3]!,
  }
}

export function usageDelta(start: TokenUsage | undefined, end: TokenUsage | undefined): TokenUsage | undefined {
  if (start === undefined || end === undefined) return undefined
  return {
    uncachedInputTokens: Math.max(0, end.uncachedInputTokens - start.uncachedInputTokens),
    cacheReadTokens: Math.max(0, end.cacheReadTokens - start.cacheReadTokens),
    cacheWriteTokens: Math.max(0, end.cacheWriteTokens - start.cacheWriteTokens),
    outputTokens: Math.max(0, end.outputTokens - start.outputTokens),
  }
}

export function inputTokenTotal(usage: TokenUsage): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

export function tokenTotal(usage: TokenUsage): number {
  return inputTokenTotal(usage) + usage.outputTokens
}

export function armMetrics(arm: ExperimentArm): ArmMetrics {
  const usage = usageDelta(arm.startUsage, arm.endUsage)
  if (usage === undefined) return {}
  return {
    usage,
    inputTokens: inputTokenTotal(usage),
    outputTokens: usage.outputTokens,
    totalTokens: tokenTotal(usage),
  }
}

export function compareExperiment(experiment: Experiment): ExperimentComparison {
  const control = armMetrics(experiment.control)
  const pagecraft = armMetrics(experiment.pagecraft)
  if (control.totalTokens === undefined || pagecraft.totalTokens === undefined) {
    return {
      kind: 'incomplete',
      control,
      pagecraft,
      reason: '两组都记录起点和终点后才能比较。',
    }
  }
  if (experiment.control.sessionId.length === 0
    || experiment.pagecraft.sessionId.length === 0
    || experiment.control.sessionId === experiment.pagecraft.sessionId) {
    return {
      kind: 'not-comparable',
      control,
      pagecraft,
      reason: 'Control 与 PageCraft 必须绑定两个不同的会话。',
    }
  }
  if (experiment.control.outcome !== 'passed' || experiment.pagecraft.outcome !== 'passed') {
    return {
      kind: 'not-comparable',
      control,
      pagecraft,
      reason: '只有两组都通过同一验收标准时才计算 token 节省率。',
    }
  }
  const savedTokens = control.totalTokens - pagecraft.totalTokens
  return {
    kind: 'comparable',
    control,
    pagecraft,
    savedTokens,
    savingRate: control.totalTokens === 0 ? 0 : savedTokens / control.totalTokens,
  }
}

export function aggregateExperiments(experiments: readonly Experiment[]): AggregateMetrics {
  const comparable = experiments
    .map(compareExperiment)
    .filter((item): item is ExperimentComparison & { savingRate: number; savedTokens: number } => (
      item.kind === 'comparable' && item.savingRate !== undefined && item.savedTokens !== undefined
    ))
  const rates = comparable.map(item => item.savingRate).sort((a, b) => a - b)
  let medianSavingRate: number | undefined
  if (rates.length > 0) {
    const middle = Math.floor(rates.length / 2)
    medianSavingRate = rates.length % 2 === 1
      ? rates[middle]
      : (rates[middle - 1] + rates[middle]) / 2
  }
  return {
    experimentCount: experiments.length,
    comparableCount: comparable.length,
    controlPassed: experiments.filter(item => item.control.outcome === 'passed').length,
    pagecraftPassed: experiments.filter(item => item.pagecraft.outcome === 'passed').length,
    medianSavingRate,
    totalSavedTokens: comparable.reduce((sum, item) => sum + item.savedTokens, 0),
  }
}

function emptyArm(sessionId = ''): ExperimentArm {
  return {
    sessionId,
    outcome: 'pending',
    turns: 0,
    clarifications: 0,
    reworks: 0,
    notes: '',
  }
}

function uniqueId(now: number): string {
  const random = Math.random().toString(36).slice(2, 9)
  return `exp-${now.toString(36)}-${random}`
}

export function createExperiment(currentSessionId = '', now = Date.now()): Experiment {
  return {
    id: uniqueId(now),
    title: '未命名对比实验',
    task: '',
    baseCommit: '',
    model: '',
    acceptanceCriteria: '',
    control: emptyArm(),
    pagecraft: emptyArm(currentSessionId),
    createdAt: now,
    updatedAt: now,
  }
}

function isArm(value: unknown): value is ExperimentArm {
  if (typeof value !== 'object' || value === null) return false
  const arm = value as Partial<ExperimentArm>
  return typeof arm.sessionId === 'string'
    && (arm.outcome === 'pending' || arm.outcome === 'passed' || arm.outcome === 'failed')
    && finiteNonNegative(arm.turns) !== undefined
    && finiteNonNegative(arm.clarifications) !== undefined
    && finiteNonNegative(arm.reworks) !== undefined
    && typeof arm.notes === 'string'
    && (arm.startUsage === undefined || normalizeTokenUsage(arm.startUsage) !== undefined)
    && (arm.endUsage === undefined || normalizeTokenUsage(arm.endUsage) !== undefined)
}

function isExperiment(value: unknown): value is Experiment {
  if (typeof value !== 'object' || value === null) return false
  const experiment = value as Partial<Experiment>
  return typeof experiment.id === 'string'
    && typeof experiment.title === 'string'
    && typeof experiment.task === 'string'
    && typeof experiment.baseCommit === 'string'
    && typeof experiment.model === 'string'
    && typeof experiment.acceptanceCriteria === 'string'
    && isArm(experiment.control)
    && isArm(experiment.pagecraft)
    && typeof experiment.createdAt === 'number'
    && typeof experiment.updatedAt === 'number'
}

export function parseExperimentStore(raw: string | null): Experiment[] {
  if (raw === null) return []
  try {
    const parsed = JSON.parse(raw) as Partial<StoredExperiments>
    if (parsed.version !== EXPERIMENT_SCHEMA_VERSION || !Array.isArray(parsed.experiments)) return []
    return parsed.experiments.filter(isExperiment)
  } catch {
    return []
  }
}

export function serializeExperimentStore(experiments: readonly Experiment[]): string {
  return JSON.stringify({ version: EXPERIMENT_SCHEMA_VERSION, experiments } satisfies StoredExperiments)
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value)
  return `"${text.replaceAll('"', '""')}"`
}

export function experimentsToCsv(experiments: readonly Experiment[]): string {
  const columns = [
    'experiment_id', 'title', 'task', 'base_commit', 'model', 'acceptance_criteria',
    'control_session', 'control_outcome', 'control_input_tokens', 'control_output_tokens', 'control_total_tokens',
    'control_turns', 'control_clarifications', 'control_reworks',
    'pagecraft_session', 'pagecraft_outcome', 'pagecraft_input_tokens', 'pagecraft_output_tokens', 'pagecraft_total_tokens',
    'pagecraft_turns', 'pagecraft_clarifications', 'pagecraft_reworks',
    'saved_tokens', 'saving_rate_percent', 'comparison_status', 'created_at', 'updated_at',
  ]
  const rows = experiments.map(experiment => {
    const comparison = compareExperiment(experiment)
    return [
      experiment.id, experiment.title, experiment.task, experiment.baseCommit, experiment.model, experiment.acceptanceCriteria,
      experiment.control.sessionId, experiment.control.outcome, comparison.control.inputTokens, comparison.control.outputTokens, comparison.control.totalTokens,
      experiment.control.turns, experiment.control.clarifications, experiment.control.reworks,
      experiment.pagecraft.sessionId, experiment.pagecraft.outcome, comparison.pagecraft.inputTokens, comparison.pagecraft.outputTokens, comparison.pagecraft.totalTokens,
      experiment.pagecraft.turns, experiment.pagecraft.clarifications, experiment.pagecraft.reworks,
      comparison.savedTokens, comparison.savingRate === undefined ? undefined : (comparison.savingRate * 100).toFixed(2), comparison.kind,
      new Date(experiment.createdAt).toISOString(), new Date(experiment.updatedAt).toISOString(),
    ].map(csvCell).join(',')
  })
  return [`\uFEFF${columns.join(',')}`, ...rows].join('\r\n')
}
