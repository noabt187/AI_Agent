import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { evalTasks } from '../eval/cases.js'
import { runToolContractEval } from '../eval/harness/toolContracts.js'
import { runTrial } from '../eval/harness/runTrial.js'
import { writeArtifacts } from '../eval/report.js'
import { loadModelConfig } from '../src/context/modelConfig.js'
import type { TrialRecord } from '../eval/types.js'

function timestampId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))
  const toolsOnly = args.has('--tools')
  const smokeOnly = args.has('--smoke')
  const runAll = args.has('--all') || (!toolsOnly && !smokeOnly)
  const resultsDir = resolve(process.cwd(), 'eval', 'results', timestampId())
  await mkdir(resultsDir, { recursive: true })
  process.env.AGENT_EVAL_LOCAL_ONLY = '1'

  // Deterministic tool checks must work in a clean checkout without API keys.
  const cfg = toolsOnly ? { model: 'not-required (tools-only)' } : await loadModelConfig()
  const contracts = await runToolContractEval()
  const trials: TrialRecord[] = []
  console.log(`[eval] Tool Contract: ${contracts.filter((item) => item.passed).length}/${contracts.length}`)
  await writeArtifacts({ resultsDir, trials, contracts, model: cfg.model })

  if (contracts.some(item => !item.passed)) {
    console.error('[eval] Tool contracts failed; model trials were not started.')
    process.exitCode = 1
    return
  }

  if (toolsOnly) {
    console.log(`[eval] Report: ${resolve(resultsDir, 'report.md')}`)
    return
  }

  const smokeTask = evalTasks[0]
  console.log(`[eval] Smoke: ${smokeTask.id}`)
  const smoke = await runTrial({ task: smokeTask, repetition: 1, runsRoot: resultsDir })
  trials.push(smoke)
  await writeArtifacts({ resultsDir, trials, contracts, model: cfg.model })
  console.log(`[eval] ${smoke.trialId}: ${smoke.status}`)

  if (smoke.status === 'infrastructure_error') {
    console.error(`[eval] Infrastructure error: ${smoke.error}`)
    console.error(`[eval] Stopped before paid batch. Report: ${resolve(resultsDir, 'report.md')}`)
    process.exitCode = 2
    return
  }
  if (smokeOnly) {
    console.log(`[eval] Report: ${resolve(resultsDir, 'report.md')}`)
    return
  }

  if (runAll) {
    for (const task of evalTasks.slice(1)) {
      console.log(`[eval] First pass: ${task.id}`)
      const trial = await runTrial({ task, repetition: 1, runsRoot: resultsDir })
      trials.push(trial)
      await writeArtifacts({ resultsDir, trials, contracts, model: cfg.model })
      console.log(`[eval] ${trial.trialId}: ${trial.status}`)
    }

    const firstRoundInfrastructureErrors = trials.filter((trial) => trial.status === 'infrastructure_error')
    if (firstRoundInfrastructureErrors.length > 0) {
      console.error('[eval] Infrastructure errors found in first round; stability repetitions were skipped.')
      process.exitCode = 2
    } else {
      for (const repetition of [2, 3]) {
        for (const task of evalTasks) {
          console.log(`[eval] Stability pass ${repetition}: ${task.id}`)
          const trial = await runTrial({ task, repetition, runsRoot: resultsDir })
          trials.push(trial)
          await writeArtifacts({ resultsDir, trials, contracts, model: cfg.model })
          console.log(`[eval] ${trial.trialId}: ${trial.status}`)
        }
      }
    }
  }

  const summary = await writeArtifacts({ resultsDir, trials, contracts, model: cfg.model })
  console.log(`[eval] pass@1=${summary.passAt1.numerator}/${summary.passAt1.denominator}`)
  console.log(`[eval] pass^3=${summary.passPower3.numerator}/${summary.passPower3.denominator}`)
  console.log(`[eval] Report: ${resolve(resultsDir, 'report.md')}`)
}

main().catch((error) => {
  console.error('[eval] fatal:', error)
  process.exitCode = 1
})
