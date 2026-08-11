import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAgentResult } from '../src/orchestrator/agent.js'

test('JSON parser finds the final action after source code containing braces', () => {
  const raw = [
    '修改如下：',
    '```js',
    'export function add(a, b) { return a + b }',
    '```',
    '{"action":"confirm","message":"修复 add","prompt":"确认修改？","confirmType":"allow_write"}',
  ].join('\n')
  assert.deepEqual(parseAgentResult(raw), {
    action: 'confirm',
    message: '修复 add',
    prompt: '确认修改？',
    confirmType: 'allow_write',
  })
})

test('JSON parser uses the last valid action object', () => {
  const raw = [
    '{"example":{"action":"confirm"}}',
    '{"action":"chat","message":"最终回答"}',
  ].join('\n')
  assert.deepEqual(parseAgentResult(raw), { action: 'chat', message: '最终回答' })
})

test('plain text and malformed JSON cannot grant write permission', () => {
  assert.equal(parseAgentResult('请确认创建 PR，确认后开始执行。'), null)
  assert.equal(parseAgentResult('{"action":"confirm","confirmType":"allow_write"'), null)

  const legacyAlias = parseAgentResult('{"action":"confirm","prompt":"确认？","confirmType":"design"}')
  assert.equal(legacyAlias?.action === 'confirm' ? legacyAlias.confirmType : undefined, undefined)

  const readOnlyConfirm = parseAgentResult('{"action":"confirm","prompt":"确认理解？"}')
  assert.deepEqual(readOnlyConfirm, {
    action: 'confirm',
    prompt: '确认理解？',
    message: undefined,
    confirmType: undefined,
  })
})

test('ask_user requires at least one concrete question', () => {
  assert.equal(parseAgentResult('{"action":"ask_user","questions":[]}'), null)
  assert.deepEqual(
    parseAgentResult('{"action":"ask_user","questions":["目标目录是什么？"]}'),
    { action: 'ask_user', questions: ['目标目录是什么？'], message: undefined },
  )
})
