import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { Agent } from '../src/orchestrator/agent.js'
import type { AgentRuntime } from '../src/orchestrator/runtime.js'
import { toolFailure } from '../src/tools/types.js'

for (const structured of [false, true]) {
  test(`Agent limits retries for ${structured ? 'structured' : 'legacy text'} plugin failures`, async t => {
    const id = `merge-tools-${randomUUID()}`
    t.after(() => rm(resolve('state', id), { recursive: true, force: true }))
    let calls = 0, executions = 0
    const codes: string[] = []
    const runtime: AgentRuntime = {
      skills: { list: async () => [], get: async () => null },
      tools: {
        definitions: () => [{ type: 'function', function: {
          name: 'probe', description: 'Test probe', parameters: { type: 'object', properties: {}, required: [] },
        } }],
        execute: async () => { executions++; return '错误：plugin denied' },
        ...(structured ? { executeResult: async () => { executions++; return toolFailure('PERMISSION_DENIED', 'plugin denied') } } : {}),
      },
    }
    const agent = new Agent(runtime, { async *streamChat(messages) {
      calls++
      if (calls > 1) {
        const result = JSON.parse(messages.filter(message => message.role === 'tool').at(-1)!.content)
        assert.equal(result.ok, false)
        codes.push(result.code)
      }
      if (calls <= 3) yield { type: 'tool_calls', toolCalls: [{ id: `probe-${calls}`, name: 'probe', arguments: '{}' }] }
      else yield { type: 'delta', text: JSON.stringify({ action: 'chat', message: 'stopped repeating failed tool' }) }
      yield { type: 'done' }
    } })
    const result = await agent.run(id, 'exercise probe', {
      sessionId: id, allowedPaths: [process.cwd()], completedTaskIds: [], failedTaskIds: [], memorySettings: { recallMode: 'off' },
    })
    assert.equal(executions, 2)
    assert.deepEqual(codes, [
      structured ? 'PERMISSION_DENIED' : 'TOOL_EXECUTION_FAILED',
      structured ? 'PERMISSION_DENIED' : 'TOOL_EXECUTION_FAILED',
      'RETRY_EXHAUSTED',
    ])
    assert.deepEqual(result, { action: 'chat', message: 'stopped repeating failed tool' })
  })
}
