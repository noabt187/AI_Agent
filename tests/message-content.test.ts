import assert from 'node:assert/strict'
import test from 'node:test'
import { messageContent } from '../web/src/messageContent.js'

test('messageContent renders only the user-facing message from agent JSON', () => {
  const content = '{"thinking":"private reasoning","action":"chat","message":"你好\\n这是正常回复","prompt":"确认继续？"}'

  assert.equal(
    messageContent({ role: 'assistant', content }),
    '你好\n这是正常回复\n\n确认继续？',
  )
})

test('messageContent hides thinking from loose agent JSON with literal newlines', () => {
  const content = `{"thinking":"用户打了个招呼，我先了解项目结构","action":"chat","message":"你好！

我看到这是一个 TypeScript 项目。

请告诉我你需要什么帮助。"}`

  assert.equal(
    messageContent({ role: 'assistant', content }),
    '你好！\n\n我看到这是一个 TypeScript 项目。\n\n请告诉我你需要什么帮助。',
  )
})

test('messageContent leaves non-agent assistant text unchanged', () => {
  const content = '普通助手回复'

  assert.equal(messageContent({ role: 'assistant', content }), content)
})

test('messageContent leaves user text unchanged', () => {
  const content = '{"thinking":"not an assistant payload","message":"hello"}'

  assert.equal(messageContent({ role: 'user', content }), content)
})
