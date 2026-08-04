import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getEvalTask } from '../eval/cases.js'
import { gradeTrial } from '../eval/graders/index.js'
import { runToolContractEval } from '../eval/harness/toolContracts.js'
import { writeArtifacts } from '../eval/report.js'
import type { ToolCallTrace, TrialRecord } from '../eval/types.js'
import { loadModelConfig } from '../src/context/modelConfig.js'

const ERROR_PREFIX = /^(错误|工具执行错误)|\berror\b|failed|failure/i

function relinkToolResults(trial: TrialRecord): ToolCallTrace[] {
  const calls: ToolCallTrace[] = trial.toolCalls.map((call) => ({
    ...call,
    result: undefined,
    resultIsError: undefined,
  }))

  for (const event of trial.events) {
    if (event.type !== 'tool_result') continue
    const call = calls.find((item) => item.name === event.name && item.result === undefined)
    if (!call) continue
    call.result = event.result
    call.resultIsError = ERROR_PREFIX.test(event.result.trim())
  }
  return calls
}

async function main(): Promise<void> {
  const input = process.argv[2]
  if (!input) throw new Error('Usage: tsx scripts/regrade-eval.ts <eval-results-directory>')
  const resultsDir = resolve(input)
  const raw = await readFile(resolve(resultsDir, 'trials.jsonl'), 'utf8')
  const trials = raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as TrialRecord)

  for (const trial of trials) {
    trial.toolCalls = relinkToolResults(trial)
    const task = getEvalTask(trial.taskId)
    trial.grade = await gradeTrial(task, trial, task.fixture)
    trial.status = trial.grade.passed ? 'passed' : 'failed'
  }

  const contracts = await runToolContractEval()
  const cfg = await loadModelConfig()
  const summary = await writeArtifacts({ resultsDir, trials, contracts, model: cfg.model })
  console.log(`[regrade] ${trials.length} trials updated`)
  console.log(`[regrade] pass@1=${summary.passAt1.numerator}/${summary.passAt1.denominator}`)
  console.log(`[regrade] pass^3=${summary.passPower3.numerator}/${summary.passPower3.denominator}`)
  console.log(`[regrade] report=${resolve(resultsDir, 'report.md')}`)
}

main().catch((error) => {
  console.error('[regrade] fatal:', error)
  process.exitCode = 1
})
