import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  executeTool,
  executeToolResult,
  toolDefsForCapabilities,
  toolDefsToOpenAI,
} from '../../src/tools/index.js'
import { resolveCommandForPlatform } from '../../src/utils/command.js'
import type { ContractCaseResult } from '../types.js'

function result(
  id: string,
  category: ContractCaseResult['category'],
  passed: boolean,
  detail: string,
): ContractCaseResult {
  return { id, category, passed, detail: detail.slice(0, 800) }
}

export async function runToolContractEval(): Promise<ContractCaseResult[]> {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-tool-contract-'))
  await mkdir(resolve(rootDir, 'src'), { recursive: true })
  await writeFile(resolve(rootDir, 'src', 'sample.txt'), 'hello agent\n', 'utf8')
  await writeFile(resolve(rootDir, 'src', 'slug.mjs'), 'export function slugify(value) { return value }\n', 'utf8')
  const previousMode = process.env.AGENT_EVAL_LOCAL_ONLY
  process.env.AGENT_EVAL_LOCAL_ONLY = '1'
  const results: ContractCaseResult[] = []

  try {
    const schemas = toolDefsToOpenAI('write')
    const schemaNames = new Set(schemas.map((item) => item.function.name))
    const requiredNames = [
      'readTextFile', 'listDirectory', 'searchFiles', 'searchContent', 'writeFile', 'deleteFile',
      'verifyCode', 'createPullRequest', 'forkRepository', 'cloneRepository', 'compressContext',
      'writeMemory',
    ]
    results.push(result(
      'schema-registry-complete',
      'schema',
      requiredNames.every((name) => schemaNames.has(name)),
      `registered=${[...schemaNames].sort().join(',')}`,
    ))

    const readOnlyNames = new Set(toolDefsForCapabilities(new Set(['read'])).map((item) => item.function.name))
    results.push(result(
      'read-only-schema-hides-side-effects',
      'schema',
      readOnlyNames.has('readTextFile')
        && !readOnlyNames.has('writeFile')
        && !readOnlyNames.has('verifyCode')
        && !schemaNames.has('saveCheckpoint'),
      `readOnly=${[...readOnlyNames].sort().join(',')}; saveCheckpointVisible=${schemaNames.has('saveCheckpoint')}`,
    ))

    const unknown = await executeTool('doesNotExist', {}, [rootDir])
    results.push(result('unknown-tool-rejected', 'argument', /未知工具|unknown tool/i.test(unknown), unknown))

    const read = await executeTool('readTextFile', { filePath: resolve(rootDir, 'src', 'sample.txt') }, [rootDir])
    results.push(result('read-file-executes', 'execution', read.includes('hello agent'), read))

    const mjsName = await executeTool('searchFiles', { rootDir, pattern: '*slug*' }, [rootDir])
    results.push(result('mjs-filename-search', 'execution', /slug\.mjs/.test(mjsName), mjsName))

    const mjsContent = await executeTool('searchContent', { rootDir, keyword: 'slugify' }, [rootDir])
    results.push(result('mjs-content-search', 'execution', /slug\.mjs:1/.test(mjsContent), mjsContent))

    const structuredUnknown = await executeToolResult('doesNotExist', {}, [rootDir])
    results.push(result(
      'structured-error-code',
      'argument',
      structuredUnknown.ok === false && structuredUnknown.code === 'UNKNOWN_TOOL',
      JSON.stringify(structuredUnknown),
    ))

    results.push(result(
      'windows-node-command-shim',
      'execution',
      resolveCommandForPlatform('npm', 'win32') === 'npm.cmd'
        && resolveCommandForPlatform('npx', 'win32') === 'npx.cmd',
      `${resolveCommandForPlatform('npm', 'win32')},${resolveCommandForPlatform('npx', 'win32')}`,
    ))

    const relative = await executeTool('readTextFile', { filePath: 'src/sample.txt' }, [rootDir])
    results.push(result('relative-path-rejected', 'isolation', /绝对路径|absolute/i.test(relative), relative))

    const outside = await executeTool('readTextFile', { filePath: resolve(tmpdir(), 'outside.txt') }, [rootDir])
    results.push(result('outside-path-rejected', 'isolation', /不在可操作目录|outside|允许/i.test(outside), outside))

    const deniedWrite = await executeTool(
      'writeFile',
      { filePath: resolve(rootDir, 'src', 'denied.txt'), content: 'blocked' },
      [rootDir],
      false,
    )
    results.push(result('write-requires-confirmation', 'permission', /未确认|确认|permission/i.test(deniedWrite), deniedWrite))

    const allowedWrite = await executeTool(
      'writeFile',
      { filePath: resolve(rootDir, 'src', 'allowed.txt'), content: 'written' },
      [rootDir],
      true,
    )
    results.push(result('authorized-write-executes', 'execution', !/错误|error/i.test(allowedWrite), allowedWrite))

    const memoryDenied = await executeTool(
      'writeMemory',
      {
        rootDir,
        layer: 'project',
        name: 'contract-memory',
        description: 'contract test memory',
        type: 'project',
        body: 'contract body',
      },
      [rootDir],
      true,
      undefined,
      { turnLoadedSkills: new Set() },
    )
    results.push(result('memory-requires-skill', 'permission', /auto-memory/.test(memoryDenied), memoryDenied))

    for (const name of ['createPullRequest', 'forkRepository', 'cloneRepository']) {
      const blocked = await executeTool(name, { rootDir, repoUrl: 'owner/repo' }, [rootDir], true)
      results.push(result(
        `${name}-blocked-in-local-eval`,
        'permission',
        /本地评测模式已阻断/.test(blocked),
        blocked,
      ))
    }
  } finally {
    if (previousMode === undefined) delete process.env.AGENT_EVAL_LOCAL_ONLY
    else process.env.AGENT_EVAL_LOCAL_ONLY = previousMode
  }

  return results
}
