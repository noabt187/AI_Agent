import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { evalTasks } from '../eval/cases.js'
import { runToolContractEval } from '../eval/harness/toolContracts.js'
import { diffSnapshots, prepareTrialWorkspace, snapshotWorkspace } from '../eval/harness/workspace.js'
import { executeToolResult } from '../src/tools/index.js'

test('local eval mode blocks all remote side-effect tools', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-eval-remote-block-'))
  const previous = process.env.AGENT_EVAL_LOCAL_ONLY
  process.env.AGENT_EVAL_LOCAL_ONLY = '1'
  try {
    for (const name of ['createPullRequest', 'forkRepository', 'cloneRepository']) {
      const result = await executeToolResult(name, { rootDir, repoUrl: 'owner/repo' }, [rootDir], true)
      assert.equal(result.code, 'REMOTE_SIDE_EFFECT_BLOCKED')
    }
  } finally {
    if (previous === undefined) delete process.env.AGENT_EVAL_LOCAL_ONLY
    else process.env.AGENT_EVAL_LOCAL_ONLY = previous
  }
})

test('trial workspace is initialized from fixture and snapshot detects only changed files', async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), 'agent-eval-workspace-'))
  const task = evalTasks.find((item) => item.id === 'single-file-fix')!
  const { workspace, baseline } = await prepareTrialWorkspace(task, runsRoot, 'fixture-r1')
  assert.equal(await readFile(resolve(workspace, 'src/math.mjs'), 'utf8'), task.fixture['src/math.mjs'])

  await executeToolResult(
    'writeFile',
    { filePath: resolve(workspace, 'src/math.mjs'), content: 'export const value = 1\n' },
    [workspace],
    true,
  )
  const after = await snapshotWorkspace(workspace)
  assert.deepEqual(diffSnapshots(baseline, after), ['src/math.mjs'])
})

test('tool contract eval passes every deterministic case', async () => {
  const results = await runToolContractEval()
  assert.ok(results.length >= 10)
  assert.deepEqual(results.filter((item) => !item.passed), [])
})
