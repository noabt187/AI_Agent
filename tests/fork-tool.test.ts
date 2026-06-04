import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAgentResult } from '../src/orchestrator/agent.js'
import { getActiveSkills, type Skill } from '../src/skills/index.js'
import { parseGitHubRepository } from '../src/tools/createPullRequest.js'
import { executeTool, getToolDescriptionsForScope, toolDefsToOpenAI } from '../src/tools/index.js'

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

test('PR confirmation without allow_write is force-upgraded to allow_write', () => {
  const parsed = parseAgentResult(JSON.stringify({
    thinking: '确认 PR 参数',
    action: 'confirm',
    message: 'PR 参数：目标仓库 guwan-real/conduit-realworld-example-app，baseBranch main，headBranch feat/article-last-edited，PR 标题 feat: test',
    prompt: '确认创建 PR？',
  }))

  assert.equal(parsed?.action, 'confirm')
  assert.equal(parsed?.action === 'confirm' ? parsed.confirmType : undefined, 'allow_write')
})

test('repository operation confirmation is force-upgraded to allow_write', () => {
  const parsed = parseAgentResult(JSON.stringify({
    thinking: '确认 fork 参数',
    action: 'confirm',
    message: 'Fork 参数：源仓库 guwan-real/conduit-realworld-example-app，目标账号 guwan-real，fork 名 conduit-realworld-example-app',
    prompt: '确认执行 forkRepository？',
  }))

  assert.equal(parsed?.action, 'confirm')
  assert.equal(parsed?.action === 'confirm' ? parsed.confirmType : undefined, 'allow_write')
})

test('markdown repository operation confirmation is parsed as allow_write', () => {
  const parsed = parseAgentResult([
    '## Clone 仓库确认',
    '',
    '- 源仓库: https://github.com/noabt187/AI_Agent',
    '- clone 目录: AI_Agent',
    '',
    '请确认以上 clone 参数是否正确。',
  ].join('\n'))

  assert.equal(parsed?.action, 'confirm')
  assert.equal(parsed?.action === 'confirm' ? parsed.confirmType : undefined, 'allow_write')
})

test('PR requests use PR skill instead of requirement analysis and stay active after confirm input', () => {
  const skills: Skill[] = [
    { name: 'requirement-analysis', trigger: 'has_goal_no_requirement', description: '', content: 'requirement skill' },
    { name: 'pull-request', trigger: 'pull_request_request', description: '', content: 'pr skill' },
    { name: 'code-generation', trigger: 'has_tasks', description: '', content: 'code skill' },
  ]
  const state = {
    sessionId: 'pr-session',
    goal: 'https://github.com/guwan-real/conduit-realworld-example-app 将修改给这个仓库提个pr',
    allowedPaths: ['/tmp/project'],
    completedTaskIds: [],
    failedTaskIds: [],
    errors: {},
  }

  assert.deepEqual(getActiveSkills(skills, state, state.goal).map((skill) => skill.name), ['pull-request'])
  assert.deepEqual(getActiveSkills(skills, state, '确认').map((skill) => skill.name), ['pull-request'])
})

test('compressContext remains exposed as a model-callable tool', () => {
  const tools = toolDefsToOpenAI('write').map((item) => item.function.name)
  const descriptions = getToolDescriptionsForScope('write')

  assert.ok(tools.includes('compressContext'))
  assert.match(descriptions, /compressContext/)
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
