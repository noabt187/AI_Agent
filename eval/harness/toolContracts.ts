import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  executeToolResult,
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
      'writeMemory', 'saveCheckpoint',
    ]
    results.push(result(
      'schema-registry-complete',
      'schema',
      requiredNames.every((name) => schemaNames.has(name)),
      `registered=${[...schemaNames].sort().join(',')}`,
    ))

    const readOnlyNames = new Set(toolDefsToOpenAI('read').map((item) => item.function.name))
    results.push(result(
      'read-only-schema-hides-side-effects',
      'schema',
      readOnlyNames.has('readTextFile')
        && !readOnlyNames.has('writeFile')
        && !readOnlyNames.has('verifyCode')
        && schemaNames.has('saveCheckpoint')
        && !readOnlyNames.has('saveCheckpoint'),
      `readOnly=${[...readOnlyNames].sort().join(',')}; saveCheckpointVisible=${schemaNames.has('saveCheckpoint')}`,
    ))

    const unknown = await executeToolResult('doesNotExist', {}, [rootDir])
    results.push(result('unknown-tool-rejected', 'argument', unknown.code === 'UNKNOWN_TOOL', unknown.message))

    const read = await executeToolResult('readTextFile', { filePath: resolve(rootDir, 'src', 'sample.txt') }, [rootDir])
    results.push(result('read-file-executes', 'execution', read.ok && read.message.includes('hello agent'), read.message))

    const mjsName = await executeToolResult('searchFiles', { rootDir, pattern: '*slug*' }, [rootDir])
    results.push(result('mjs-filename-search', 'execution', mjsName.ok && /slug\.mjs/.test(mjsName.message), mjsName.message))

    const mjsContent = await executeToolResult('searchContent', { rootDir, keyword: 'slugify' }, [rootDir])
    results.push(result('mjs-content-search', 'execution', mjsContent.ok && /slug\.mjs:1/.test(mjsContent.message), mjsContent.message))

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

    const relative = await executeToolResult('readTextFile', { filePath: 'src/sample.txt' }, [rootDir])
    results.push(result('relative-path-rejected', 'isolation', relative.code === 'PATH_OUTSIDE_ALLOWED', relative.message))

    const outside = await executeToolResult('readTextFile', { filePath: resolve(tmpdir(), 'outside.txt') }, [rootDir])
    results.push(result('outside-path-rejected', 'isolation', outside.code === 'PATH_OUTSIDE_ALLOWED', outside.message))

    const deniedWrite = await executeToolResult(
      'writeFile',
      { filePath: resolve(rootDir, 'src', 'denied.txt'), content: 'blocked' },
      [rootDir],
      false,
    )
    results.push(result('write-requires-confirmation', 'permission', deniedWrite.code === 'PERMISSION_DENIED', deniedWrite.message))

    const allowedWrite = await executeToolResult(
      'writeFile',
      { filePath: resolve(rootDir, 'src', 'allowed.txt'), content: 'written' },
      [rootDir],
      true,
    )
    results.push(result('authorized-write-executes', 'execution', allowedWrite.ok, allowedWrite.message))

    const memoryDenied = await executeToolResult(
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
    results.push(result('memory-requires-skill', 'permission', memoryDenied.code === 'PERMISSION_DENIED', memoryDenied.message))

    for (const name of ['createPullRequest', 'forkRepository', 'cloneRepository']) {
      const blocked = await executeToolResult(name, { rootDir, repoUrl: 'owner/repo' }, [rootDir], true)
      results.push(result(
        `${name}-blocked-in-local-eval`,
        'permission',
        blocked.code === 'REMOTE_SIDE_EFFECT_BLOCKED',
        blocked.message,
      ))
    }
  } finally {
    if (previousMode === undefined) delete process.env.AGENT_EVAL_LOCAL_ONLY
    else process.env.AGENT_EVAL_LOCAL_ONLY = previousMode
  }

  return results
}
