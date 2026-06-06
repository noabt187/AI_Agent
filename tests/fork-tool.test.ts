import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAgentResult } from '../src/orchestrator/agent.js'
import { useSkill, getSkillCatalog, type Skill } from '../src/skills/index.js'
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

test('useSkill returns content for known skill, null for unknown', () => {
  const skills: Skill[] = [
    { name: 'requirement-analysis', description: '需求分析指引', content: 'requirement skill body' },
    { name: 'pull-request', description: 'PR 指引', content: 'pr skill body' },
  ]

  assert.equal(useSkill(skills, 'pull-request'), 'pr skill body')
  assert.equal(useSkill(skills, 'requirement-analysis'), 'requirement skill body')
  assert.equal(useSkill(skills, 'nonexistent'), null)
})

test('getSkillCatalog returns compact listing', () => {
  const skills: Skill[] = [
    { name: 'requirement-analysis', description: '需求分析指引', content: 'body1' },
    { name: 'pull-request', description: 'PR 指引', content: 'body2' },
  ]

  const catalog = getSkillCatalog(skills)
  assert.match(catalog, /requirement-analysis/)
  assert.match(catalog, /需求分析指引/)
  assert.match(catalog, /pull-request/)
  assert.match(catalog, /PR 指引/)
})

test('forkRepository validates required repoUrl before invoking gh', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-fork-tool-'))
  const result = await executeTool('forkRepository', { rootDir }, [rootDir], true)

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
    true,
  )

  assert.match(result, /绝对路径|路径越界/)
})
