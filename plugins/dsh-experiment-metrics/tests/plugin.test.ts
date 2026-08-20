import assert from 'node:assert/strict'
import test from 'node:test'
import {
  aggregateExperiments,
  compareExperiment,
  createExperiment,
  experimentsToCsv,
  normalizeTokenUsage,
  parseExperimentStore,
  serializeExperimentStore,
  tokenTotal,
  usageDelta,
} from '../lib/index.js'
import type { Experiment, TokenUsage } from '../lib/index.js'

const zero: TokenUsage = {
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
}

function experiment(controlTotal: number, pagecraftTotal: number, outcomes: ['passed' | 'failed', 'passed' | 'failed'] = ['passed', 'passed']): Experiment {
  const value = createExperiment('pagecraft-session', 1_700_000_000_000)
  value.control.sessionId = 'control-session'
  value.control.startUsage = zero
  value.control.endUsage = { ...zero, uncachedInputTokens: controlTotal }
  value.control.outcome = outcomes[0]
  value.pagecraft.startUsage = zero
  value.pagecraft.endUsage = { ...zero, uncachedInputTokens: pagecraftTotal }
  value.pagecraft.outcome = outcomes[1]
  return value
}

test('normalizes native DSH tokenUsage and rejects malformed values', () => {
  assert.deepEqual(normalizeTokenUsage({
    uncachedInputTokens: 10,
    cacheReadTokens: 20,
    cacheWriteTokens: 30,
    outputTokens: 40,
  }), {
    uncachedInputTokens: 10,
    cacheReadTokens: 20,
    cacheWriteTokens: 30,
    outputTokens: 40,
  })
  assert.equal(normalizeTokenUsage({ uncachedInputTokens: 10 }), undefined)
  assert.equal(normalizeTokenUsage({ ...zero, outputTokens: -1 }), undefined)
})

test('calculates bounded snapshot deltas and all processed token buckets', () => {
  const delta = usageDelta({
    uncachedInputTokens: 100,
    cacheReadTokens: 20,
    cacheWriteTokens: 10,
    outputTokens: 30,
  }, {
    uncachedInputTokens: 250,
    cacheReadTokens: 70,
    cacheWriteTokens: 5,
    outputTokens: 80,
  })
  assert.deepEqual(delta, {
    uncachedInputTokens: 150,
    cacheReadTokens: 50,
    cacheWriteTokens: 0,
    outputTokens: 50,
  })
  assert.equal(tokenTotal(delta!), 250)
})

test('only reports savings when both distinct arms pass', () => {
  const comparable = compareExperiment(experiment(1_000, 600))
  assert.equal(comparable.kind, 'comparable')
  assert.equal(comparable.savedTokens, 400)
  assert.equal(comparable.savingRate, 0.4)

  const failed = compareExperiment(experiment(1_000, 100, ['passed', 'failed']))
  assert.equal(failed.kind, 'not-comparable')
  assert.equal(failed.savedTokens, undefined)

  const sameSession = experiment(1_000, 600)
  sameSession.control.sessionId = sameSession.pagecraft.sessionId
  assert.equal(compareExperiment(sameSession).kind, 'not-comparable')
})

test('aggregates completed pairs with a median resistant to outliers', () => {
  const result = aggregateExperiments([
    experiment(1_000, 900),
    experiment(1_000, 600),
    experiment(1_000, 100),
    experiment(1_000, 50, ['failed', 'passed']),
  ])
  assert.equal(result.experimentCount, 4)
  assert.equal(result.comparableCount, 3)
  assert.equal(result.medianSavingRate, 0.4)
  assert.equal(result.totalSavedTokens, 1_400)
})

test('storage parser ignores corruption and retains valid experiments', () => {
  const original = experiment(1_000, 600)
  assert.deepEqual(parseExperimentStore(serializeExperimentStore([original])), [original])
  assert.deepEqual(parseExperimentStore('{broken'), [])
  assert.deepEqual(parseExperimentStore(JSON.stringify({ version: 99, experiments: [original] })), [])
})

test('CSV export escapes user text and includes comparison fields', () => {
  const original = experiment(1_000, 600)
  original.title = '按钮, "微调"'
  const csv = experimentsToCsv([original])
  assert.match(csv, /^\uFEFFexperiment_id/)
  assert.match(csv, /"按钮, ""微调"""/)
  assert.match(csv, /"400"/)
  assert.match(csv, /"40\.00"/)
})
