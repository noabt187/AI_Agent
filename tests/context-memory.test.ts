import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { maybeCompressContext } from '../src/context/contextCompressor.js'
import { loadModelConfig } from '../src/context/modelConfig.js'
import { QueryEngine } from '../src/QueryEngine.js'
import { buildRuntimeContext, buildTaskMemorySearchQuery, parseAgentResult, shouldRecallTaskMemories } from '../src/orchestrator/agent.js'
import { Orchestrator } from '../src/orchestrator/orchestrator.js'
import { appendPinnedProjectMemory, appendProjectMemory, createAndStoreProjectMemory, deletePinnedProjectMemory, formatPinnedProjectMemoryContext, formatProjectMemoryContext, loadPinnedProjectMemories, resolveProjectInfo, searchProjectMemories } from '../src/memory/projectMemory.js'
import { loadMessages, loadOrchestratorState, saveMessages } from '../src/state/sessionStore.js'
import { executeTool } from '../src/tools/index.js'
import type { Message } from '../src/types/index.js'
import type { LlmClient } from '../src/llm/types.js'
import type { ProjectMemory } from '../src/memory/projectMemory.js'
import type { WorldState } from '../src/orchestrator/types.js'

async function withTempCwd<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const previous = process.cwd()
  const dir = await mkdtemp(join(tmpdir(), prefix))
  process.chdir(dir)
  try {
    return await fn(dir)
  } finally {
    process.chdir(previous)
  }
}

function msg(role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return {
    uuid: `${role}-${Math.random()}`,
    role,
    content,
    createdAt: Date.now(),
    ...extra,
  }
}

test('agent parser accepts loose confirm JSON with nested code fences', () => {
  const raw = `Now I have a complete understanding.

\`\`\`json
{
  "thinking": "发现 .then(setForm({ body: "" })) 会立即执行",
  "action": "confirm",
  "message": "需求分析：
\`\`\`js
.then(setForm({ body: \\"\\" }))
\`\`\`
修复后只在成功后清空",
  "questions": []
}
\`\`\``

  const parsed = parseAgentResult(raw)

  assert.equal(parsed?.action, 'confirm')
  assert.equal(parsed?.action === 'confirm' ? parsed.confirmType : undefined, undefined)
  assert.match(parsed?.action === 'confirm' ? parsed.message ?? '' : '', /成功后清空/)
})

test('agent parser treats explicit markdown requirement confirmation as confirm', () => {
  const raw = `## 需求标题
前端 errorHandler 防御性改造

## 需求概述
当前 errorHandler 会因为非标准错误结构抛出二次 TypeError。

## 相关文件
- frontend/src/helpers/errorHandler.js

请确认以上需求是否正确，我将进入方案设计阶段。`

  const parsed = parseAgentResult(raw)

  assert.equal(parsed?.action, 'confirm')
  assert.equal(parsed?.action === 'confirm' ? parsed.confirmType : undefined, undefined)
})

test('runtime context is sent to the model without being persisted', async () => {
  const seenRequests: Message[][] = []
  const fakeLlm: LlmClient = {
    async *streamChat(messages) {
      seenRequests.push(messages)
      yield { type: 'delta', text: '{"action":"chat","message":"ok"}' }
      yield { type: 'done' }
    },
  }

  class TestQueryEngine extends QueryEngine {
    async persist(): Promise<void> {}
  }

  const engine = new TestQueryEngine({
    sessionId: 'runtime-context-test',
    llmClient: fakeLlm,
  }, [
    msg('system', 'stable system'),
    msg('user', 'previous user'),
    msg('assistant', 'previous assistant'),
  ])

  for await (const _evt of engine.submitMessage('change navbar title', {
    runtimeContext: '当前状态: 需求分析阶段\n相关项目记忆: navbar 曾经改过品牌名',
  })) {}

  const persistedUserMessages = engine.state.messages.filter((item) => item.role === 'user' && !item.isMeta)
  assert.equal(persistedUserMessages.at(-1)?.content, 'change navbar title')
  assert.match(seenRequests[0].at(-1)?.content ?? '', /本轮临时上下文/)
  assert.match(seenRequests[0].at(-1)?.content ?? '', /navbar 曾经改过品牌名/)
  assert.match(seenRequests[0].at(-1)?.content ?? '', /用户输入/)
})

test('context compression does not run below hard threshold', async () => {
  await withTempCwd('agent-context-soft-', async () => {
    const sessionId = 'soft-session'
    const messages = [
      msg('system', 'stable system'),
      msg('user', 'short request'),
      msg('assistant', 'short answer'),
    ]
    await saveMessages(sessionId, messages)

    const compressed = await maybeCompressContext(sessionId, {
      softThresholdTokens: 1,
      hardThresholdTokens: 10_000,
      dangerThresholdTokens: 20_000,
      compressor: async () => {
        throw new Error('compressor should not run')
      },
    })

    assert.equal(compressed, false)
    assert.deepEqual(await loadMessages(sessionId), messages)
  })
})

test('context compression includes previous compressed summaries when recompressing', async () => {
  await withTempCwd('agent-context-hard-', async () => {
    const sessionId = 'hard-session'
    const messages = [
      msg('system', 'stable system'),
      msg('user', '[压缩上下文] 旧摘要：用户之前要求实现 PR 工具', { isCompressed: true }),
      msg('user', 'round 1 user'),
      msg('assistant', 'round 1 assistant'),
      msg('user', 'round 2 user'),
      msg('assistant', 'round 2 assistant'),
      msg('user', 'round 3 user'),
      msg('assistant', 'round 3 assistant'),
      msg('user', 'round 4 user'),
      msg('assistant', 'round 4 assistant'),
    ]
    await saveMessages(sessionId, messages)

    let compressorInput = ''
    const compressed = await maybeCompressContext(sessionId, {
      hardThresholdTokens: 1,
      dangerThresholdTokens: 100_000,
      keepRounds: 2,
      compressor: async (oldMessages) => {
        compressorInput = oldMessages.map((item) => item.content).join('\n')
        return '新摘要：保留旧摘要，并记录前两轮对话'
      },
    })

    const nextMessages = await loadMessages(sessionId)
    assert.equal(compressed, true)
    assert.match(compressorInput, /旧摘要：用户之前要求实现 PR 工具/)
    assert.equal(nextMessages.filter((item) => item.isCompressed).length, 1)
    assert.match(nextMessages.find((item) => item.isCompressed)?.content ?? '', /新摘要/)
    assert.deepEqual(
      nextMessages.filter((item) => item.role === 'user' && !item.isCompressed).map((item) => item.content),
      ['round 3 user', 'round 4 user'],
    )
  })
})

test('context compression keeps system protocol out of compressor input', async () => {
  await withTempCwd('agent-context-protocol-', async () => {
    const sessionId = 'protocol-session'
    await saveMessages(sessionId, [
      msg('system', '重要工作流程：不要跳过 requirement confirm 或 design confirm'),
      msg('user', '[本轮临时上下文]\n## 当前状态\nWorldState pendingConfirm allowedPaths\n\n[用户输入]\n请把导航栏品牌名改成 free'),
      msg('assistant', '我会先阅读 Navbar.jsx 并确认需求'),
      msg('user', 'round 2 user'),
      msg('assistant', 'round 2 assistant'),
      msg('user', 'round 3 user'),
      msg('assistant', 'round 3 assistant'),
    ])

    let compressorInput = ''
    const compressed = await maybeCompressContext(sessionId, {
      hardThresholdTokens: 1,
      dangerThresholdTokens: 100_000,
      keepRounds: 1,
      compressor: async (oldMessages) => {
        compressorInput = oldMessages.map((item) => item.content).join('\n')
        return '摘要：用户要修改导航栏品牌名'
      },
    })

    assert.equal(compressed, true)
    assert.doesNotMatch(compressorInput, /重要工作流程/)
    assert.doesNotMatch(compressorInput, /WorldState/)
    assert.doesNotMatch(compressorInput, /pendingConfirm/)
    assert.match(compressorInput, /请把导航栏品牌名改成 free/)
  })
})

test('context compression danger fallback trims low-value old messages when compressor fails', async () => {
  await withTempCwd('agent-context-danger-', async () => {
    const sessionId = 'danger-session'
    const messages = [
      msg('system', 'stable system prompt'),
      msg('user', 'old request about navbar'),
      msg('assistant', 'old analysis'),
      msg('tool', '工具执行结果：very noisy output'.repeat(200), { isMeta: true, toolName: 'readFile', toolCallId: 'tc-1' }),
      msg('assistant', '工具失败后的内部说明', { isMeta: true }),
      msg('user', 'recent user 1'),
      msg('assistant', 'recent assistant 1'),
      msg('user', 'recent user 2'),
      msg('assistant', 'recent assistant 2'),
    ]
    await saveMessages(sessionId, messages)

    const compressed = await maybeCompressContext(sessionId, {
      hardThresholdTokens: 1,
      dangerThresholdTokens: 1,
      keepRounds: 2,
      compressor: async () => null,
    })

    const nextMessages = await loadMessages(sessionId)
    assert.equal(compressed, true)
    assert.equal(nextMessages[0].role, 'system')
    assert.ok(nextMessages.some((item) => item.content === 'old request about navbar'))
    assert.ok(nextMessages.some((item) => item.content === 'recent user 1'))
    assert.ok(nextMessages.some((item) => item.content === 'recent user 2'))
    assert.ok(!nextMessages.some((item) => item.role === 'tool'))
    assert.ok(!nextMessages.some((item) => item.isMeta))
  })
})

test('project memory is stored locally and can be retrieved by similar requests', async () => {
  await withTempCwd('agent-project-memory-', async (cwd) => {
    const projectDir = join(cwd, 'target-project')
    await mkdir(projectDir)
    const project = await resolveProjectInfo(projectDir)
    const memory: ProjectMemory = {
      id: 'memory-1',
      createdAt: Date.now(),
      project,
      source: { sessionId: 'session-1', hash: 'hash-1' },
      requirement: {
        summary: '把导航栏品牌名从 conduit 改成 free',
        keywords: ['导航栏', '品牌名', 'free'],
        targetModules: ['frontend/src/components/Navbar'],
      },
      plan: {
        summary: '修改 Navbar 组件里的品牌文案',
        tasks: ['更新 Navbar.jsx 中的品牌文字'],
        decisions: ['只改文案，不调整路由'],
      },
      implementation: {
        changedFiles: ['frontend/src/components/Navbar/Navbar.jsx'],
        patterns: ['React Link 文案修改'],
        components: ['Navbar'],
      },
      verification: {
        summary: '通过人工检查',
        commands: [],
        failures: [],
      },
      reuseHints: ['相似品牌名需求优先检查 Navbar.jsx'],
      constraints: ['不要跳过确认流程'],
    }

    await appendProjectMemory(projectDir, memory)
    const results = await searchProjectMemories(projectDir, '导航栏改成 free', 3)
    const formatted = formatProjectMemoryContext(results)

    assert.equal(results.length, 1)
    assert.equal(results[0].id, 'memory-1')
    assert.match(formatted, /Navbar\.jsx/)
    assert.match(formatted, /不代表当前代码事实/)
    assert.doesNotMatch(formatted, /不要跳过确认流程/)
  })
})

test('project memory search requires effective terms, threshold, and returns top 3', async () => {
  await withTempCwd('agent-project-memory-threshold-', async (cwd) => {
    const projectDir = join(cwd, 'target-project')
    await mkdir(projectDir)
    const project = await resolveProjectInfo(projectDir)

    for (let i = 0; i < 4; i++) {
      await appendProjectMemory(projectDir, {
        id: `navbar-memory-${i}`,
        createdAt: Date.now() + i,
        project,
        source: { sessionId: `session-${i}`, hash: `hash-${i}` },
        requirement: {
          summary: `导航栏品牌名修改经验 ${i}`,
          keywords: ['导航栏', '品牌名', 'Navbar', 'free'],
          targetModules: ['frontend/src/components/Navbar'],
        },
        plan: { summary: '修改 Navbar 文案', tasks: [], decisions: [] },
        implementation: {
          changedFiles: [`frontend/src/components/Navbar/Navbar${i}.jsx`],
          patterns: ['React Link text'],
          components: ['Navbar'],
        },
        verification: { summary: '构建通过', commands: [], failures: [] },
        reuseHints: ['相似品牌名需求优先检查 Navbar'],
        constraints: [],
      })
    }

    assert.deepEqual(await searchProjectMemories(projectDir, '确认', 3), [])

    const results = await searchProjectMemories(projectDir, '导航栏品牌名改成 free', 3)
    assert.equal(results.length, 3)
    assert.deepEqual(results.map((item) => item.id), ['navbar-memory-3', 'navbar-memory-2', 'navbar-memory-1'])
  })
})

test('pinned project memory is stored in agent state and can be deleted', async () => {
  await withTempCwd('agent-pinned-memory-', async (cwd) => {
    const projectDir = join(cwd, 'target-project')
    await mkdir(projectDir)

    const added = await appendPinnedProjectMemory(projectDir, '后续这个项目里所有前端改动都要先确认交互文案。', 'session-1')
    const duplicate = await appendPinnedProjectMemory(projectDir, '后续这个项目里所有前端改动都要先确认交互文案。', 'session-1')
    const pinned = await loadPinnedProjectMemories(projectDir)
    const formatted = formatPinnedProjectMemoryContext(pinned)

    assert.equal(added.created, true)
    assert.equal(duplicate.created, false)
    assert.equal(pinned.length, 1)
    assert.match(formatted, /先确认交互文案/)
    assert.deepEqual(await readdir(projectDir), [])

    assert.equal(await deletePinnedProjectMemory(projectDir, added.memory.id), true)
    assert.deepEqual(await loadPinnedProjectMemories(projectDir), [])
  })
})

test('memory recall policy supports auto off and on modes', () => {
  const baseState: WorldState = {
    sessionId: 'memory-policy-session',
    allowedPaths: ['/repo'],
    completedTaskIds: [],
    failedTaskIds: [],
    errors: {},
    goal: '修改导航栏品牌名',
  }

  assert.equal(shouldRecallTaskMemories({ ...baseState, memorySettings: { recallMode: 'auto' } }, '把导航栏改成 free'), true)
  assert.equal(shouldRecallTaskMemories({ ...baseState, memorySettings: { recallMode: 'auto' }, confirmedRequirement: '已确认需求' }, '确认'), false)
  assert.equal(shouldRecallTaskMemories({ ...baseState, memorySettings: { recallMode: 'off' } }, '把导航栏改成 free'), false)
  assert.equal(shouldRecallTaskMemories({ ...baseState, memorySettings: { recallMode: 'on' }, confirmedRequirement: '已确认需求' }, '确认'), true)
  assert.equal(buildTaskMemorySearchQuery({ ...baseState, confirmedRequirement: '已确认需求：修改 Navbar 文案' }, '确认'), '已确认需求：修改 Navbar 文案')
})

test('runtime context can include pinned memory while task memory is off', async () => {
  const state: WorldState = {
    sessionId: 'runtime-pinned-memory',
    allowedPaths: ['/repo'],
    completedTaskIds: [],
    failedTaskIds: [],
    errors: {},
    memorySettings: { recallMode: 'off' },
  }

  const runtimeContext = buildRuntimeContext(
    state,
    '',
    '',
    '固定记忆 1 [m1]: 所有前端改动都要保留现有样式密度。',
  )

  assert.match(runtimeContext, /项目固定记忆/)
  assert.match(runtimeContext, /保留现有样式密度/)
  assert.doesNotMatch(runtimeContext, /相关历史任务记忆/)
})

test('memory slash commands persist settings and pinned memories', async () => {
  await withTempCwd('agent-memory-command-', async (cwd) => {
    const projectDir = join(cwd, 'target-project')
    await mkdir(projectDir)
    const state: WorldState = {
      sessionId: 'memory-command-session',
      allowedPaths: [projectDir],
      completedTaskIds: [],
      failedTaskIds: [],
      errors: {},
    }
    const orchestrator = new Orchestrator(state.sessionId, state)

    await orchestrator.handleUserInput('/memory off')
    assert.equal(orchestrator.state.memorySettings?.recallMode, 'off')
    assert.equal((await loadOrchestratorState<WorldState>(state.sessionId))?.memorySettings?.recallMode, 'off')

    await orchestrator.handleUserInput('/memory on')
    assert.equal(orchestrator.state.memorySettings?.recallMode, 'on')

    await orchestrator.handleUserInput('/remember 当前项目所有新增前端控件都要保持 8px 圆角。')
    const pinned = await loadPinnedProjectMemories(projectDir)
    assert.equal(pinned.length, 1)
    assert.match(pinned[0].content, /8px 圆角/)
    assert.deepEqual(await readdir(projectDir), [])

    await orchestrator.handleUserInput(`/memory forget ${pinned[0].id}`)
    assert.deepEqual(await loadPinnedProjectMemories(projectDir), [])
  })
})

test('model config supports role-specific compression and memory models', async () => {
  await withTempCwd('agent-model-config-role-', async () => {
    await mkdir('config', { recursive: true })
    await writeFile('config/model.json', JSON.stringify({
      provider: 'openai',
      base_url: 'http://main.example/v1',
      api_key: 'test-key',
      model: 'main-model',
      compressionModel: 'compression-mini',
      memoryModel: {
        base_url: 'http://memory.example/v1',
        model: 'memory-mini',
      },
    }))

    const main = await loadModelConfig()
    const compression = await loadModelConfig('compression')
    const memory = await loadModelConfig('memory')

    assert.equal(main.model, 'main-model')
    assert.equal(compression.model, 'compression-mini')
    assert.equal(compression.base_url, 'http://main.example/v1')
    assert.equal(memory.model, 'memory-mini')
    assert.equal(memory.base_url, 'http://memory.example/v1')
    assert.equal(memory.provider, 'openai')
  })
})

test('project memory fallback stores structured design when memory model is unavailable', async () => {
  await withTempCwd('agent-project-memory-fallback-', async (cwd) => {
    const projectDir = join(cwd, 'target-project')
    await mkdir(projectDir)
    const sessionId = 'memory-fallback-session'
    await saveMessages(sessionId, [
      msg('user', '请把导航栏品牌名改成 free'),
      msg('assistant', '已修改 Navbar.jsx，并运行 npm run build'),
    ])

    const memory = await createAndStoreProjectMemory({
      projectDir,
      sessionId,
      doneMessage: '任务完成，构建通过。',
      state: {
        sessionId,
        allowedPaths: [projectDir],
        goal: '把导航栏品牌名从 conduit 改成 free',
        confirmedRequirement: '只改品牌文案，不改路由',
        designTasks: [
          { id: 'T1', title: '修改 Navbar', description: '改品牌文案', file: 'frontend/src/components/Navbar/Navbar.jsx', changeType: 'modify', dependencies: [], rationale: '品牌展示位置' },
          { id: 'T2', title: '运行构建', description: '验证构建', file: 'package.json', changeType: 'modify', dependencies: ['T1'], rationale: '验证命令' },
        ],
        completedTaskIds: ['T1', 'T2'],
        failedTaskIds: [],
        errors: {},
      },
    })

    assert.ok(memory)
    assert.deepEqual(memory.implementation.changedFiles, ['frontend/src/components/Navbar/Navbar.jsx', 'package.json'])
    assert.match(memory.plan.summary, /修改 Navbar/)
    assert.equal(memory.constraints.length, 0)
  })
})

test('project memory search ignores generic terms and protocol-only constraints', async () => {
  await withTempCwd('agent-project-memory-generic-', async (cwd) => {
    const projectDir = join(cwd, 'target-project')
    await mkdir(projectDir)
    const project = await resolveProjectInfo(projectDir)
    await appendProjectMemory(projectDir, {
      id: 'auth-memory',
      createdAt: Date.now(),
      project,
      source: { sessionId: 'session-auth', hash: 'hash-auth' },
      requirement: {
        summary: '修复 loggedUser invalid JSON 时认证上下文崩溃',
        keywords: ['认证上下文', 'loggedUser', 'localStorage'],
        targetModules: ['frontend/src/context'],
      },
      plan: { summary: '增加 parseLoggedUser 保护解析', tasks: [], decisions: [] },
      implementation: {
        changedFiles: ['frontend/src/context/AuthContext.jsx'],
        patterns: ['localStorage JSON parse guard'],
        components: ['AuthContext'],
      },
      verification: { summary: '测试通过', commands: [], failures: [] },
      reuseHints: ['相似认证持久化问题优先检查 AuthContext.jsx'],
      constraints: ['不要跳过确认流程'],
    })

    const genericResults = await searchProjectMemories(projectDir, '前端错误不会崩溃', 3)
    const specificResults = await searchProjectMemories(projectDir, 'loggedUser localStorage invalid JSON', 3)

    assert.equal(genericResults.length, 0)
    assert.equal(specificResults.length, 1)
    assert.equal(specificResults[0].id, 'auth-memory')
  })
})

test('agent memory A/B: comment hide request reuses prior comment-like memory only when available', async () => {
  await withTempCwd('agent-memory-ab-', async (cwd) => {
    const records: Array<{
      hasMemory: boolean
      promptTokens: number
      lastUserContent: string
      responseText: string
      latencyMs: number
    }> = []
    const fakeLlm: LlmClient = {
      async *streamChat(messages) {
        const startedAt = performance.now()
        const lastUserContent = messages.findLast((item) => item.role === 'user')?.content ?? ''
        const hasMemory = /相关历史任务记忆/.test(lastUserContent) && /CommentActions\.jsx/.test(lastUserContent)
        const response = hasMemory
          ? {
              thinking: '检测到评论点赞历史记忆，可复用评论操作入口和本地状态更新模式。',
              action: 'confirm',
              message: '需求分析：为评论列表增加隐藏评论功能。基于历史评论点赞实现，优先检查 frontend/src/components/Article/CommentItem.jsx、frontend/src/components/Article/CommentActions.jsx 和 frontend/src/api/comments.js，复用评论操作区与 comments state 更新模式。',
              prompt: '请确认以上需求分析是否正确。',
              questions: [],
            }
          : {
              thinking: '没有相关项目记忆，只能先根据用户描述定位评论列表。',
              action: 'confirm',
              message: '需求分析：为评论列表增加隐藏评论功能。需要先阅读项目中评论列表、评论项组件和评论 API 的现有实现来确认修改点。',
              prompt: '请确认以上需求分析是否正确。',
              questions: [],
            }
        const responseText = JSON.stringify(response)
        const promptTokens = Math.ceil(JSON.stringify(messages).length / 4)
        const completionTokens = Math.ceil(responseText.length / 4)
        records.push({ hasMemory, promptTokens, lastUserContent, responseText, latencyMs: Number((performance.now() - startedAt).toFixed(3)) })
        yield { type: 'delta', text: responseText }
        yield { type: 'done', usage: { promptTokens, completionTokens } }
      },
    }

    async function runProbe(sessionId: string, userInput: string, memoryContext: string) {
      const state = {
        sessionId,
        allowedPaths: [projectDir],
        completedTaskIds: [],
        failedTaskIds: [],
        errors: {},
      }
      const engine = new QueryEngine({ sessionId, llmClient: fakeLlm }, [
        msg('system', 'stable system prompt'),
      ])
      let fullText = ''
      for await (const evt of engine.submitMessage(userInput, {
        runtimeContext: buildRuntimeContext(state, memoryContext, ''),
      })) {
        if (evt.kind === 'delta') fullText += evt.delta
      }
      return {
        result: parseAgentResult(fullText),
        persisted: await loadMessages(sessionId),
      }
    }

    const projectDir = join(cwd, 'target-project')
    await mkdir(projectDir)
    const userInput = '请在评论列表里加一个隐藏评论功能，作者可以隐藏评论，隐藏后列表不再展示。'

    const resultWithout = await runProbe(
      'comment-hide-without-memory',
      userInput,
      formatProjectMemoryContext(await searchProjectMemories(projectDir, userInput, 3)),
    )

    const project = await resolveProjectInfo(projectDir)
    await appendProjectMemory(projectDir, {
      id: 'comment-like-memory',
      createdAt: Date.now(),
      project,
      source: { sessionId: 'comment-like-session', hash: 'comment-like-hash' },
      requirement: {
        summary: '在评论列表给每条评论添加点赞按钮和点赞数展示',
        keywords: ['评论列表', '评论操作区', '点赞按钮', 'CommentItem', 'CommentActions'],
        targetModules: ['frontend/src/components/Article/评论列表', 'frontend/src/components/Article'],
      },
      plan: {
        summary: '在评论项操作区添加点赞入口，通过 comments API 触发 mutation，成功后更新本地 comments state。',
        tasks: ['扩展 CommentActions 操作区', '新增 comments API mutation', '在 Article 评论状态中更新单条评论'],
        decisions: ['评论类交互集中放在 CommentActions，避免散落到 Article 页面主体'],
      },
      implementation: {
        changedFiles: [
          'frontend/src/components/Article/CommentItem.jsx',
          'frontend/src/components/Article/CommentActions.jsx',
          'frontend/src/api/comments.js',
        ],
        patterns: ['comment action slot', 'comment id mutation', 'update comments state by id'],
        components: ['CommentItem', 'CommentActions', 'commentsApi'],
      },
      verification: {
        summary: '通过评论列表手工验证和 npm run build',
        commands: ['npm run build'],
        failures: [],
      },
      reuseHints: [
        '相似评论交互优先检查 CommentItem.jsx 与 CommentActions.jsx',
        '复用 comments API mutation 后按 comment id 更新本地 comments state',
      ],
      constraints: ['评论操作入口保持在 CommentActions 中'],
    })

    const memoryResults = await searchProjectMemories(projectDir, userInput, 3)
    const resultWith = await runProbe(
      'comment-hide-with-memory',
      userInput,
      formatProjectMemoryContext(memoryResults),
    )

    if (process.env.PRINT_CONTEXT_EVAL) {
      console.log(JSON.stringify({
        withoutMemory: records[0],
        withMemory: records[1],
        memoryHits: memoryResults.length,
        promptTokenDelta: records[1].promptTokens - records[0].promptTokens,
      }))
    }

    assert.equal(resultWithout.result?.action, 'confirm')
    assert.equal(resultWith.result?.action, 'confirm')
    assert.equal(memoryResults.length, 1)
    assert.equal(records.length, 2)
    assert.equal(records[0].hasMemory, false)
    assert.equal(records[1].hasMemory, true)
    assert.match(resultWithout.result?.action === 'confirm' ? resultWithout.result.message ?? '' : '', /需要先阅读项目中评论列表/)
    assert.match(resultWith.result?.action === 'confirm' ? resultWith.result.message ?? '' : '', /CommentActions\.jsx/)
    assert.ok(records[0].promptTokens > 0)
    assert.ok(records[1].promptTokens > records[0].promptTokens)
    assert.doesNotMatch(resultWith.persisted.find((item) => item.role === 'user' && !item.isMeta)?.content ?? '', /相关历史任务记忆/)
    assert.doesNotMatch(resultWith.persisted[0]?.content ?? '', /相关历史任务记忆|CommentActions\.jsx/)
  })
})

test('write tools cannot bypass design confirmation', async () => {
  await withTempCwd('agent-write-gate-', async (cwd) => {
    const rejected = await executeTool(
      'writeFile',
      { rootDir: cwd, relativePath: 'demo.txt', content: 'hello' },
      [cwd],
      'write',
      false,
    )

    assert.match(rejected, /当前未确认方案/)
    assert.match(rejected, /等待用户确认后再修改代码/)
  })
})

test('memory integration does not restore phase or checkpoint flow', async () => {
  const agent = await readFile(new URL('../src/orchestrator/agent.ts', import.meta.url), 'utf8')
  const orchestrator = await readFile(new URL('../src/orchestrator/orchestrator.ts', import.meta.url), 'utf8')
  const types = await readFile(new URL('../src/orchestrator/types.ts', import.meta.url), 'utf8')
  const tools = await readFile(new URL('../src/tools/index.ts', import.meta.url), 'utf8')

  assert.doesNotMatch(agent, /setPhase|AgentPhase|state\.phase|code_generation/)
  assert.doesNotMatch(orchestrator, /checkpoint|saveDesignCheckpoint|loadDesignCheckpoint|state\.phase|code_generation/)
  assert.doesNotMatch(types, /AgentPhase|CheckpointSnapshot|phase/)
  assert.doesNotMatch(tools, /requiresDesignConfirmation|code_generation|phase\?:/)
})
