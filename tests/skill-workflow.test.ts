import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildWorkflowSnapshot,
  formatSkillContext,
  resolveNextNode,
  selectActiveSkills,
  type Skill,
} from '../src/skills/index.js'

const skills: Skill[] = [
  { name: 'requirement-analysis', trigger: 'workflow', node: 'requirement-analysis', entry: 'development', summary: 'requirements', onConfirmNext: 'solution-design', onAllowWriteNext: 'code-generation', priority: 100, content: 'requirement detail' },
  { name: 'solution-design', trigger: 'workflow', node: 'solution-design', summary: 'design', onAllowWriteNext: 'code-generation', priority: 90, content: 'solution detail' },
  { name: 'code-generation', trigger: 'workflow', node: 'code-generation', summary: 'code', priority: 80, content: 'code detail' },
  { name: 'pull-request', trigger: 'pull_request_request', node: 'pull-request', entry: 'pull_request_request', summary: 'pr', priority: 200, content: 'pr detail' },
  { name: 'repository-tools', trigger: 'repository_request', node: 'repository-tools', entry: 'repository_request', summary: 'repo', priority: 200, content: 'repo detail' },
]

const baseState = {
  sessionId: 'skill-session',
  allowedPaths: ['/tmp/project'],
  completedTaskIds: [],
  failedTaskIds: [],
  errors: {},
}

test('workflow snapshot adapts legacy state fields into stable workflow facts', () => {
  const writeSnapshot = buildWorkflowSnapshot({ ...baseState, designConfirmed: true }, '确认')
  assert.equal(writeSnapshot.writeAllowed, true)
  assert.equal(writeSnapshot.node, 'code-generation')

  const pendingSnapshot = buildWorkflowSnapshot({ ...baseState, pendingConfirm: { allowWrite: false, message: '确认需求' } }, '确认')
  assert.equal(pendingSnapshot.hasPendingConfirm, true)

  assert.equal(buildWorkflowSnapshot(baseState, '帮我提交 PR').intent, 'pull_request')
  assert.equal(buildWorkflowSnapshot(baseState, 'clone 这个仓库').intent, 'repository')
})

test('workflow intent ignores negated repository and PR keywords', () => {
  assert.equal(buildWorkflowSnapshot(baseState, '只做本地验证，不要提交 PR').intent, 'development')
  assert.equal(buildWorkflowSnapshot(baseState, '不要 fork，不要 clone，只分析代码').intent, 'development')
  assert.equal(buildWorkflowSnapshot(baseState, '不要 fork 或 clone，只分析代码').intent, 'development')
  assert.equal(buildWorkflowSnapshot(baseState, '这不是提交 PR 的问题，先看代码').intent, 'development')
  assert.equal(buildWorkflowSnapshot(baseState, '看看 repository 的目录结构').intent, 'development')
  assert.equal(buildWorkflowSnapshot(baseState, '这个 bug 是 cloned 对象导致的').intent, 'development')
})

test('workflow intent still catches positive repository and PR actions', () => {
  assert.equal(buildWorkflowSnapshot(baseState, '/pr 到 main').intent, 'pull_request')
  assert.equal(buildWorkflowSnapshot(baseState, 'PR 到 main').intent, 'pull_request')
  assert.equal(buildWorkflowSnapshot(baseState, '给这个改动提一个 PR').intent, 'pull_request')
  assert.equal(buildWorkflowSnapshot(baseState, '不要 fork，直接 clone 这个仓库').intent, 'repository')

  const prState = { ...baseState, goal: '给这个改动提 PR' }
  assert.equal(buildWorkflowSnapshot(prState, '确认').intent, 'pull_request')
})

test('skill selection uses workflow snapshot instead of direct WorldState fields', () => {
  assert.deepEqual(selectActiveSkills(skills, buildWorkflowSnapshot(baseState, '改文案')).details.map((s) => s.name), ['requirement-analysis'])
  assert.deepEqual(selectActiveSkills(skills, buildWorkflowSnapshot({ ...baseState, confirmedRequirement: '需求已确认' }, '确认')).details.map((s) => s.name), ['solution-design'])
  assert.deepEqual(selectActiveSkills(skills, buildWorkflowSnapshot({ ...baseState, designConfirmed: true }, '确认')).details.map((s) => s.name), ['code-generation'])
  assert.deepEqual(selectActiveSkills(skills, buildWorkflowSnapshot(baseState, '给这个改动提 PR')).details.map((s) => s.name), ['pull-request'])
  assert.deepEqual(selectActiveSkills(skills, buildWorkflowSnapshot(baseState, 'fork 这个仓库')).details.map((s) => s.name), ['repository-tools'])
})

test('workflow resolver supports inserting a skill between two nodes', () => {
  const inserted: Skill = {
    name: 'user-understanding',
    trigger: 'workflow',
    node: 'user-understanding',
    summary: 'understand user intent',
    insertAfter: 'requirement-analysis',
    insertBefore: 'solution-design',
    onConfirmNext: 'solution-design',
    priority: 50,
    content: 'understanding detail',
  }

  assert.equal(resolveNextNode('requirement-analysis', 'solution-design', skills), 'solution-design')
  assert.equal(resolveNextNode('requirement-analysis', 'solution-design', [...skills, inserted]), 'user-understanding')
})

test('skill selection can include one supporting lifecycle skill for inserted nodes', () => {
  const inserted: Skill = {
    name: 'user-understanding',
    trigger: 'workflow',
    node: 'user-understanding',
    summary: 'understand user intent',
    insertAfter: 'requirement-analysis',
    insertBefore: 'solution-design',
    priority: 50,
    content: 'understanding detail',
  }

  const snapshot = {
    ...buildWorkflowSnapshot({ ...baseState, confirmedRequirement: '需求已确认' }, '确认'),
    node: 'user-understanding',
  }
  const selection = selectActiveSkills([...skills, inserted], snapshot)

  assert.deepEqual(selection.details.map((skill) => skill.name), ['user-understanding', 'solution-design'])
  assert.equal(selection.details.length, 2)
})

test('skill context includes index but only active skill details', () => {
  const selection = selectActiveSkills(skills, buildWorkflowSnapshot(baseState, '改文案'))
  const context = formatSkillContext(skills, selection)

  assert.equal(selection.details.length, 1)
  assert.match(context, /Skill Index/)
  assert.match(context, /requirement detail/)
  assert.doesNotMatch(context, /solution detail/)
  assert.doesNotMatch(context, /code detail/)
})
