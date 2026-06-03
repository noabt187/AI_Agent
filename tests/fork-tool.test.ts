import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseGitHubRepository } from '../src/tools/createPullRequest.js'
import { executeTool, toolDefsToOpenAI } from '../src/tools/index.js'

test('parseGitHubRepository accepts common GitHub repository formats', () => {
  assert.deepEqual(parseGitHubRepository('https://github.com/noabt187/AI_Agent.git'), {
    owner: 'noabt187',
    name: 'AI_Agent',
    fullName: 'noabt187/AI_Agent',
  })

  assert.deepEqual(parseGitHubRepository('git@github.com:guwan-real/Vibecoding-skills-for-interview.git'), {
    owner: 'guwan-real',
    name: 'Vibecoding-skills-for-interview',
    fullName: 'guwan-real/Vibecoding-skills-for-interview',
  })

  assert.deepEqual(parseGitHubRepository('guwan-real/Vibecoding-skills-for-interview'), {
    owner: 'guwan-real',
    name: 'Vibecoding-skills-for-interview',
    fullName: 'guwan-real/Vibecoding-skills-for-interview',
  })

  assert.deepEqual(parseGitHubRepository('https://github.com/guwan-real/Vibecoding-skills-for-interview/tree/main'), {
    owner: 'guwan-real',
    name: 'Vibecoding-skills-for-interview',
    fullName: 'guwan-real/Vibecoding-skills-for-interview',
  })
})

test('forkRepository OpenAI schema is remote fork only', () => {
  const tool = toolDefsToOpenAI('write').find((item) => item.function.name === 'forkRepository')

  assert.ok(tool)
  assert.deepEqual(tool.function.parameters.required, ['rootDir', 'repoUrl'])
  assert.ok('forkName' in tool.function.parameters.properties)
  assert.ok(!('cloneParentDir' in tool.function.parameters.properties))
  assert.ok(!('cloneDirName' in tool.function.parameters.properties))
  assert.ok(!('branchName' in tool.function.parameters.properties))
  assert.match(tool.function.description, /Fork GitHub 仓库/)
})

test('cloneRepository OpenAI schema is independent from fork and PR', () => {
  const tool = toolDefsToOpenAI('write').find((item) => item.function.name === 'cloneRepository')

  assert.ok(tool)
  assert.deepEqual(tool.function.parameters.required, ['rootDir', 'repoUrl'])
  assert.ok('cloneParentDir' in tool.function.parameters.properties)
  assert.ok('cloneDirName' in tool.function.parameters.properties)
  assert.ok('upstreamUrl' in tool.function.parameters.properties)
  assert.match(tool.function.description, /Clone 任意 Git 仓库/)
})

test('createPullRequest keeps optional PR metadata in schema', () => {
  const tool = toolDefsToOpenAI('write').find((item) => item.function.name === 'createPullRequest')

  assert.ok(tool)
  assert.deepEqual(tool.function.parameters.required, ['rootDir'])
  assert.ok('title' in tool.function.parameters.properties)
  assert.ok('prRepoUrl' in tool.function.parameters.properties)
  assert.ok('headOwner' in tool.function.parameters.properties)
})

test('forkRepository validates required repoUrl before invoking gh', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-fork-tool-'))
  const result = await executeTool('forkRepository', { rootDir }, [rootDir], 'write', true)

  assert.match(result, /缺少必需参数 "repoUrl"/)
})

test('cloneRepository rejects cloneParentDir outside allowed workspace', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-fork-tool-'))
  const result = await executeTool(
    'cloneRepository',
    {
      rootDir,
      repoUrl: 'guwan-real/Vibecoding-skills-for-interview',
      cloneParentDir: '..',
    },
    [rootDir],
    'write',
    true,
  )

  assert.match(result, /路径越界/)
})
