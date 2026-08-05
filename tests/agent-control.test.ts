import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAgentResult } from '../src/orchestrator/agent.js'
import {
  CONTROL_TOOL_DEFS,
  parseControlToolCall,
} from '../src/orchestrator/controlTools.js'

test('control tool schemas expose confirmation, question and finish actions', () => {
  assert.deepEqual(
    CONTROL_TOOL_DEFS.map((item) => item.function.name),
    ['request_confirmation', 'ask_user', 'finish'],
  )
})

test('request_confirmation maps to a scoped confirmation result', () => {
  const parsed = parseControlToolCall({
    id: 'control-1',
    name: 'request_confirmation',
    arguments: JSON.stringify({
      message: '将修复两个文件并运行测试',
      prompt: '确认执行？',
      scope: 'workspace_write',
    }),
  })
  assert.deepEqual(parsed.result, {
    action: 'confirm',
    message: '将修复两个文件并运行测试',
    prompt: '确认执行？',
    confirmType: 'allow_write',
    confirmScope: 'workspace_write',
  })
})

test('ask_user rejects an empty question list', () => {
  const parsed = parseControlToolCall({
    id: 'control-2',
    name: 'ask_user',
    arguments: JSON.stringify({ questions: [] }),
  })
  assert.equal(parsed.result, undefined)
  assert.match(parsed.error ?? '', /至少包含一个/)
})

test('finish maps answered and completed outcomes to existing AgentResult variants', () => {
  const answered = parseControlToolCall({
    id: 'control-3',
    name: 'finish',
    arguments: JSON.stringify({ message: '答案', outcome: 'answered' }),
  })
  const completed = parseControlToolCall({
    id: 'control-4',
    name: 'finish',
    arguments: JSON.stringify({ message: '完成', outcome: 'completed' }),
  })
  assert.deepEqual(answered.result, { action: 'chat', message: '答案', taskComplete: true })
  assert.deepEqual(completed.result, { action: 'done', message: '完成' })
})

test('fallback parser finds the last valid control JSON after code containing braces', () => {
  const raw = [
    '修改如下：',
    '```js',
    'export function add(a, b) { return a + b }',
    '```',
    '{"action":"confirm","message":"修复 add","prompt":"确认修改？","confirmType":"allow_write"}',
  ].join('\n')
  const parsed = parseAgentResult(raw)
  assert.equal(parsed?.action, 'confirm')
  assert.equal(parsed?.action === 'confirm' ? parsed.prompt : '', '确认修改？')
})

test('legacy chat JSON is terminal so stale write authorization can be revoked', () => {
  const parsed = parseAgentResult('{"action":"chat","message":"兼容回复"}')
  assert.deepEqual(parsed, { action: 'chat', message: '兼容回复', taskComplete: true })
})
