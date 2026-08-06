import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ContractCaseResult, EvalSummary, TrialRecord } from './types.js'

const execFileAsync = promisify(execFile)

function ratio(numerator: number, denominator: number): { numerator: number; denominator: number; value: number } {
  return { numerator, denominator, value: denominator === 0 ? 0 : numerator / denominator }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

async function gitCommit(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd() })
    return String(stdout).trim()
  } catch {
    return 'unknown'
  }
}

export async function buildSummary(
  trials: TrialRecord[],
  contracts: ContractCaseResult[],
  model: string,
): Promise<EvalSummary> {
  const valid = trials.filter((trial) => trial.grade && (trial.status === 'passed' || trial.status === 'failed'))
  const passed = valid.filter((trial) => trial.status === 'passed')
  const firstRuns = valid.filter((trial) => trial.repetition === 1)
  const taskIds = [...new Set(valid.map((trial) => trial.taskId))]
  const completeThreeRunTasks = taskIds.filter((taskId) => {
    const taskRuns = valid.filter((trial) => trial.taskId === taskId)
    return [1, 2, 3].every((repetition) => taskRuns.some((trial) => trial.repetition === repetition))
  })
  const stableTasks = completeThreeRunTasks.filter((taskId) => (
    [1, 2, 3].every((repetition) => valid.some((trial) => (
      trial.taskId === taskId && trial.repetition === repetition && trial.status === 'passed'
    )))
  ))
  const allToolCalls = valid.flatMap((trial) => trial.toolCalls)
  const validArguments = valid.reduce((sum, trial) => sum + (trial.grade?.validArgumentCalls ?? 0), 0)
  const relevantCalls = valid.reduce((sum, trial) => sum + (trial.grade?.relevantToolCalls ?? 0), 0)
  const errorTrials = valid.filter((trial) => trial.grade?.errorOccurred)
  const recoveredTrials = errorTrials.filter((trial) => trial.grade?.recoveredFromError)
  const verificationCalls = allToolCalls.filter((call) => call.name === 'verifyCode')
  const verificationExecutions = verificationCalls.filter((call) => {
    if (!call.result) return false
    try {
      const parsed = JSON.parse(call.result) as { code?: string }
      return (parsed.code === 'OK' || parsed.code === 'COMMAND_FAILED')
        && !/spawn\s+\S+\s+(?:ENOENT|EINVAL)/i.test(call.result)
    } catch {
      return !/spawn\s+\S+\s+(?:ENOENT|EINVAL)/i.test(call.result)
    }
  })

  return {
    generatedAt: new Date().toISOString(),
    gitCommit: await gitCommit(),
    model,
    taskCount: taskIds.length,
    trialCount: trials.length,
    validTrialCount: valid.length,
    passedTrials: passed.length,
    passAt1: ratio(firstRuns.filter((trial) => trial.status === 'passed').length, firstRuns.length),
    passPower3: ratio(stableTasks.length, completeThreeRunTasks.length),
    hiddenOutcomeRate: ratio(valid.filter((trial) => trial.grade?.outcomePassed).length, valid.length),
    permissionViolationRate: ratio(valid.filter((trial) => trial.grade?.permissionViolation).length, valid.length),
    outOfScopeChangeRate: ratio(valid.filter((trial) => (trial.grade?.outOfScopeChanges.length ?? 0) > 0).length, valid.length),
    argumentValidityRate: ratio(validArguments, allToolCalls.length),
    toolSelectionPrecision: ratio(relevantCalls, allToolCalls.length),
    errorRecoveryRate: ratio(recoveredTrials.length, errorTrials.length),
    providerRetryRate: ratio(
      valid.filter((trial) => (trial.metrics.providerRetryCount ?? 0) > 0).length,
      valid.length,
    ),
    verificationExecutionRate: ratio(verificationExecutions.length, verificationCalls.length),
    authorizationLeakRate: ratio(
      valid.filter((trial) => trial.grade?.authorizationLeaked).length,
      valid.length,
    ),
    medianLlmCalls: median(passed.map((trial) => trial.metrics.llmCallCount)),
    medianToolCalls: median(passed.map((trial) => trial.metrics.toolCallCount)),
    medianTotalTokens: median(passed.map((trial) => trial.metrics.totalTokens)),
    medianDurationMs: median(passed.map((trial) => trial.metrics.durationMs)),
    contract: {
      passed: contracts.filter((item) => item.passed).length,
      total: contracts.length,
      rate: contracts.length === 0 ? 0 : contracts.filter((item) => item.passed).length / contracts.length,
    },
  }
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function metricLine(label: string, metric: { numerator: number; denominator: number; value: number }): string {
  return `| ${label} | ${metric.numerator}/${metric.denominator} | ${percent(metric.value)} |`
}

function markdownReport(
  summary: EvalSummary,
  trials: TrialRecord[],
  contracts: ContractCaseResult[],
): string {
  const trialRows = trials.map((trial) => {
    const assertions = trial.grade?.assertions
      .filter((item) => !item.passed)
      .map((item) => item.name)
      .join(', ') || '-'
    return `| ${trial.trialId} | ${trial.status} | ${trial.metrics.llmCallCount} | ${trial.metrics.toolCallCount} | ${trial.metrics.totalTokens} | ${assertions} |`
  })
  const failedContracts = contracts.filter((item) => !item.passed)
  const resumeSentence = summary.validTrialCount > 0
    ? `构建包含 ${summary.taskCount} 类任务的本地隔离 Agent Eval，首轮 pass@1 为 ${percent(summary.passAt1.value)}（${summary.passAt1.numerator}/${summary.passAt1.denominator}），三次连续成功率 pass³ 为 ${percent(summary.passPower3.value)}（${summary.passPower3.numerator}/${summary.passPower3.denominator}），权限违规率为 ${percent(summary.permissionViolationRate.value)}。`
    : 'Agent Trial 未形成有效结果，不能生成量化简历表述。'

  return [
    '# AI Agent 真实评测报告',
    '',
    `- 生成时间：${summary.generatedAt}`,
    `- Git Commit：${summary.gitCommit}`,
    `- 模型：${summary.model}`,
    `- 有效 Trials：${summary.validTrialCount}/${summary.trialCount}`,
    '',
    '## Tool Contract Eval',
    '',
    `通过 ${summary.contract.passed}/${summary.contract.total}（${percent(summary.contract.rate)}）。`,
    '',
    ...(failedContracts.length === 0
      ? ['未发现 Tool Contract 失败。']
      : failedContracts.map((item) => `- ${item.id}: ${item.detail}`)),
    '',
    '## Agent 指标',
    '',
    '| 指标 | 分子/分母 | 结果 |',
    '|---|---:|---:|',
    metricLine('pass@1', summary.passAt1),
    metricLine('pass³', summary.passPower3),
    metricLine('Outcome Pass Rate', summary.hiddenOutcomeRate),
    metricLine('Permission Violation Rate', summary.permissionViolationRate),
    metricLine('Out-of-scope Change Rate', summary.outOfScopeChangeRate),
    metricLine('Argument Validity Rate', summary.argumentValidityRate),
    metricLine('Tool Selection Precision', summary.toolSelectionPrecision),
    metricLine('Error Recovery Rate', summary.errorRecoveryRate),
    metricLine('Provider Retry Rate', summary.providerRetryRate),
    metricLine('Verification Execution Rate', summary.verificationExecutionRate),
    metricLine('Authorization Leak Rate', summary.authorizationLeakRate),
    '',
    '## 效率',
    '',
    `- 成功 Trial 的 LLM 调用次数中位数：${summary.medianLlmCalls}`,
    `- 成功 Trial 的工具调用次数中位数：${summary.medianToolCalls}`,
    `- 成功 Trial 的 Token 中位数：${summary.medianTotalTokens}`,
    `- 成功 Trial 的总耗时中位数：${Math.round(summary.medianDurationMs)} ms`,
    '',
    '## Trial 明细',
    '',
    '| Trial | 状态 | LLM Calls | Tool Calls | Tokens | 未通过断言 |',
    '|---|---|---:|---:|---:|---|',
    ...trialRows,
    '',
    '## 简历可用表述',
    '',
    `> ${resumeSentence}`,
    '',
    '该表述仅基于本报告中的有效 Trials，不代表生产环境线上指标。',
    '',
  ].join('\n')
}

function redact(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_API_KEY]')
}

export async function writeArtifacts(params: {
  resultsDir: string
  trials: TrialRecord[]
  contracts: ContractCaseResult[]
  model: string
}): Promise<EvalSummary> {
  const { resultsDir, trials, contracts, model } = params
  await mkdir(resolve(resultsDir, 'traces'), { recursive: true })
  const summary = await buildSummary(trials, contracts, model)
  const trialsJsonl = trials.map((trial) => redact(JSON.stringify(trial))).join('\n')
  await writeFile(resolve(resultsDir, 'trials.jsonl'), trialsJsonl ? `${trialsJsonl}\n` : '', 'utf8')
  await writeFile(resolve(resultsDir, 'summary.json'), redact(JSON.stringify(summary, null, 2)), 'utf8')
  await writeFile(resolve(resultsDir, 'report.md'), markdownReport(summary, trials, contracts), 'utf8')
  for (const trial of trials) {
    await writeFile(
      resolve(resultsDir, 'traces', `${trial.trialId}.json`),
      redact(JSON.stringify(trial, null, 2)),
      'utf8',
    )
  }
  return summary
}
