import assert from 'node:assert/strict'
import test from 'node:test'
import { QueryEngine } from '../src/QueryEngine.js'
import type { LlmClient } from '../src/llm/types.js'

test('provider retry is an event and only the successful attempt is persisted', async () => {
  let calls = 0
  const llmClient: LlmClient = {
    async *streamChat() {
      calls++
      if (calls === 1) {
        yield { type: 'delta' as const, text: 'failed partial response' }
        yield { type: 'error' as const, error: 'HTTP 500: temporary failure' }
        return
      }
      yield { type: 'delta' as const, text: 'successful response' }
      yield { type: 'done' as const, usage: { promptTokens: 1, completionTokens: 1 } }
    },
  }

  const engine = new QueryEngine(
    { sessionId: `retry-test-${Date.now()}`, llmClient },
    [{ uuid: 'system', role: 'system', content: 'system', createdAt: Date.now() }],
  )
  const events = []
  for await (const event of engine.queryLoop()) events.push(event)

  const retry = events.find((event) => event.kind === 'retry')
  assert.ok(retry)
  assert.equal(retry.kind === 'retry' ? retry.reason : '', '服务端错误')
  const persistedAssistant = engine.state.messages.filter((message) => message.role === 'assistant')
  assert.equal(persistedAssistant.length, 1)
  assert.equal(persistedAssistant[0].content, 'successful response')
  assert.ok(!persistedAssistant[0].content.includes('重试'))
  assert.ok(!persistedAssistant[0].content.includes('failed partial'))
})
