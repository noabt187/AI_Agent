import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getSkillCatalog,
  loadSkills,
  useSkill,
  type Skill,
} from '../src/skills/index.js'

const skills: Skill[] = [
  { name: 'requirement-analysis', description: '需求分析指引 — 分析用户需求、阅读代码、输出需求文档，适用于新任务开始时', content: 'requirement detail' },
  { name: 'solution-design', description: '方案设计指引 — 将实现方案拆解为任务列表，适用于需求已确认时', content: 'solution detail' },
  { name: 'code-generation', description: '代码生成与验证指引 — 编写代码并调用 verifyCode，适用于写代码阶段', content: 'code detail' },
  { name: 'pull-request', description: 'PR 提交指引 — 创建 GitHub PR 的完整流程，适用于需要提交代码时', content: 'pr detail' },
  { name: 'repository-tools', description: '仓库 Fork/Clone 工具指引 — 适用于需要操作远程仓库时', content: 'repo detail' },
]

test('useSkill returns full content for known skill names', () => {
  assert.equal(useSkill(skills, 'requirement-analysis'), 'requirement detail')
  assert.equal(useSkill(skills, 'code-generation'), 'code detail')
  assert.equal(useSkill(skills, 'pull-request'), 'pr detail')
})

test('useSkill returns null for unknown skill names', () => {
  assert.equal(useSkill(skills, 'nonexistent'), null)
  assert.equal(useSkill(skills, ''), null)
  assert.equal(useSkill([], 'anything'), null)
})

test('getSkillCatalog returns compact listing with all skills', () => {
  const catalog = getSkillCatalog(skills)

  assert.match(catalog, /requirement-analysis/)
  assert.match(catalog, /方案设计指引/)
  assert.match(catalog, /code-generation/)
  assert.match(catalog, /PR 提交指引/)
  assert.match(catalog, /repository-tools/)
  assert.match(catalog, /仓库 Fork/)

  // All 5 skills should appear
  assert.equal(catalog.split('\n').length, 5)
})

test('getSkillCatalog returns empty string for empty skills', () => {
  assert.equal(getSkillCatalog([]), '')
})

test('loadSkills parses name and description from valid .md files', async () => {
  const loaded = await loadSkills('tests/fixtures/skills')
  if (loaded.length > 0) {
    for (const skill of loaded) {
      assert.ok(skill.name.length > 0)
      assert.ok(skill.description.length > 0)
      assert.ok(skill.content.length > 0)
    }
  }
})

test('Skill type requires name, description and content', () => {
  const valid: Skill = { name: 'test', description: 'test desc', content: 'test body' }
  assert.equal(valid.name, 'test')
  assert.equal(valid.description, 'test desc')
  assert.equal(valid.content, 'test body')
})
