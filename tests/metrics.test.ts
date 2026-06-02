import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadMetricsFromStateDir } from '../src/server/metrics.js'

test('loadMetricsFromStateDir reads metrics and calculates summary', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-metrics-'))
  await mkdir(join(stateDir, 'session-001'))
  await writeFile(join(stateDir, 'session-001', 'metrics.json'), JSON.stringify({
    sessionId: 'session-001',
    startedAt: 100,
    calls: [
      { timestamp: 110, promptTokens: 10, completionTokens: 5, latencyMs: 1000, firstTokenMs: 200 },
      { timestamp: 120, promptTokens: 20, completionTokens: 15, latencyMs: 3000, firstTokenMs: 400 },
    ],
  }))

  const metrics = await loadMetricsFromStateDir(stateDir, 'session-001')

  assert.equal(metrics.sessionId, 'session-001')
  assert.equal(metrics.summary.callCount, 2)
  assert.equal(metrics.summary.totalPromptTokens, 30)
  assert.equal(metrics.summary.totalCompletionTokens, 20)
  assert.equal(metrics.summary.totalTokens, 50)
  assert.equal(metrics.summary.averageLatencyMs, 2000)
  assert.equal(metrics.summary.averageFirstTokenMs, 300)
})

test('loadMetricsFromStateDir returns empty metrics when file is missing', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'agent-metrics-empty-'))
  const metrics = await loadMetricsFromStateDir(stateDir, 'session-404')

  assert.equal(metrics.sessionId, 'session-404')
  assert.equal(metrics.calls.length, 0)
  assert.equal(metrics.summary.callCount, 0)
})
