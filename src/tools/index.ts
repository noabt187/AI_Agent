import { isAbsolute } from 'node:path'
import { readTextFile, listDirectory, searchFiles, searchContent } from './fileRead.js'
import { writeFileTool, deleteFileTool } from './fileWrite.js'

import { verifyCodeTool } from './verifyCode.js'
import { createPullRequestTool } from './createPullRequest.js'
import { forkRepositoryTool, cloneRepositoryTool } from './repositoryTools.js'
import { compressContextTool } from './compressContext.js'
import { writeMemoryTool } from './writeMemory.js'
import { saveCheckpointTool } from './saveCheckpoint.js'
import { isInsideAllowedPaths } from '../utils/pathUtils.js'
import type { ToolDefinition } from '../llm/types.js'
import type { RepositoryConfig } from '../orchestrator/types.js'
import { CommandError } from '../utils/command.js'
import {
  toolFailure,
  toolResultFromLegacyOutput,
  toolResultToLegacyOutput,
  type ToolResult,
} from './types.js'

export type ToolScope = 'read' | 'write' | 'memory'

export type ToolFn = (rootDir: string, ...args: string[]) => Promise<string>

export type ToolDef = {
  fn: ToolFn
  withSignal?: (rootDir: string, args: string[], signal?: AbortSignal) => Promise<string>
  description: string
  argNames: string[]
  scope: ToolScope
  requiredArgNames?: string[]
  pathArgNames?: string[]
  argDescriptions?: Record<string, string>
}

export type ExecuteToolOptions = {
  turnLoadedSkills?: Set<string>
  repository?: RepositoryConfig
}

const REMOTE_SIDE_EFFECT_TOOLS = new Set([
  'createPullRequest',
  'forkRepository',
  'cloneRepository',
])

function isDefaultValueToken(value: string | undefined): boolean {
  const trimmed = value?.trim().toLowerCase() ?? ''
  return !trimmed || trimmed === 'auto' || trimmed === '-'
}

function applyRepositoryDefaults(
  name: string,
  args: Record<string, string>,
  repository?: RepositoryConfig,
): Record<string, string> {
  const nextArgs = { ...args }
  if (name === 'createPullRequest') {
    if (isDefaultValueToken(nextArgs.repoUrl) && repository?.repoUrl) nextArgs.repoUrl = repository.repoUrl
    if (isDefaultValueToken(nextArgs.prRepoUrl) && repository?.prRepoUrl) nextArgs.prRepoUrl = repository.prRepoUrl
    if (isDefaultValueToken(nextArgs.baseBranch) && repository?.defaultBaseBranch) {
      nextArgs.baseBranch = repository.defaultBaseBranch
    }
  }
  if (name === 'forkRepository' && isDefaultValueToken(nextArgs.repoUrl)) {
    const defaultForkSource = repository?.upstreamUrl || repository?.prRepoUrl || repository?.repoUrl
    if (defaultForkSource) nextArgs.repoUrl = defaultForkSource
  }
  if (name === 'cloneRepository' && isDefaultValueToken(nextArgs.repoUrl)) {
    const defaultCloneSource = repository?.repoUrl || repository?.upstreamUrl
    if (defaultCloneSource) nextArgs.repoUrl = defaultCloneSource
  }
  return nextArgs
}

// ── Registry ────────────────────────────────────────────────────────

export const builtinToolRegistry: Readonly<Record<string, ToolDef>> = {
  readTextFile: {
    fn: readTextFile,
    description: '读取指定绝对路径的文本文件内容',
    argNames: ['filePath'],
    pathArgNames: ['filePath'],
    scope: 'read',
  },
  listDirectory: {
    fn: listDirectory,
    description: '列出指定绝对路径目录下的文件和文件夹',
    argNames: ['dirPath'],
    pathArgNames: ['dirPath'],
    scope: 'read',
  },
  searchFiles: {
    fn: searchFiles,
    description: '按文件名模式搜索文件（支持 * 通配符）',
    argNames: ['rootDir', 'pattern'],
    scope: 'read',
  },
  searchContent: {
    fn: searchContent,
    description: '按关键词搜索代码内容，返回匹配的文件名、行号和内容',
    argNames: ['rootDir', 'keyword'],
    scope: 'read',
  },
  writeFile: {
    fn: writeFileTool,
    description: '创建或覆盖写入文件（自动创建父目录），filePath 为绝对路径',
    argNames: ['filePath', 'content'],
    pathArgNames: ['filePath'],
    scope: 'write',
  },
  deleteFile: {
    fn: deleteFileTool,
    description: '删除指定绝对路径的文件（需要人工确认）',
    argNames: ['filePath'],
    pathArgNames: ['filePath'],
    scope: 'write',
  },
  verifyCode: {
    fn: (rootDir, changedFiles) => verifyCodeTool(rootDir, changedFiles),
    withSignal: (rootDir, args, signal) => verifyCodeTool(rootDir, args[0] ?? '', signal),
    description: '验证代码质量。第一层：自动检测并运行 tsc --noEmit / lint / build / test（可用则跑，不可用则跳过）。第二层：API 契约检查——提取后端路由定义与前端 API 调用，检查是否匹配。rootDir 为项目根目录。',
    argNames: ['rootDir', 'changedFiles'],
    scope: 'write',
  },
  createPullRequest: {
    fn: createPullRequestTool,
    description: '把当前项目的本地改动提交到分支并创建 GitHub PR。repoUrl 是推送仓库，auto 读取 origin；prRepoUrl 是 PR 目标仓库，auto 表示同 repoUrl；draft 默认 true。参数: repoUrl,title,body,baseBranch,headBranch,commitMessage,draft,remote,prRepoUrl,headOwner',
    argNames: ['rootDir', 'repoUrl', 'title', 'body', 'baseBranch', 'headBranch', 'commitMessage', 'draft', 'remote', 'prRepoUrl', 'headOwner'],
    scope: 'write',
    requiredArgNames: ['rootDir'],
    argDescriptions: {
      title: 'title，可传 auto 使用默认值',
      body: 'body，可传 auto 使用默认值',
      baseBranch: 'baseBranch，可传 auto 使用默认值',
      headBranch: 'headBranch，可传 auto 使用默认值',
      commitMessage: 'commitMessage，可传 auto 使用默认值',
      draft: 'draft，可传 auto 使用默认值',
      remote: 'remote，可传 auto 使用默认值',
      prRepoUrl: 'prRepoUrl，可传 auto 使用默认值',
      headOwner: 'headOwner，可传 auto 使用默认值',
    },
  },
  forkRepository: {
    fn: forkRepositoryTool,
    description: 'Fork GitHub 仓库到当前 gh 登录账号或指定组织。只创建远程 fork，不 clone、不创建分支、不提交 PR。参数: repoUrl,targetOwner,forkName,defaultBranchOnly',
    argNames: ['rootDir', 'repoUrl', 'targetOwner', 'forkName', 'defaultBranchOnly'],
    scope: 'write',
    requiredArgNames: ['rootDir', 'repoUrl'],
  },
  cloneRepository: {
    fn: cloneRepositoryTool,
    description: 'Clone 任意 Git 仓库到用户指定本地目录。只 clone，不 fork、不提交 PR；可选添加一个额外 remote。参数: repoUrl,cloneParentDir,cloneDirName,remoteName,upstreamUrl,upstreamRemoteName',
    argNames: ['rootDir', 'repoUrl', 'cloneParentDir', 'cloneDirName', 'remoteName', 'upstreamUrl', 'upstreamRemoteName'],
    scope: 'write',
    requiredArgNames: ['rootDir', 'repoUrl'],
    pathArgNames: ['cloneParentDir'],
  },
  compressContext: {
    fn: compressContextTool,
    description: '压缩当前会话上下文，减少 token 消耗。sessionId 为当前会话 ID',
    argNames: ['rootDir', 'sessionId'],
    scope: 'read',
  },
  writeMemory: {
    fn: writeMemoryTool,
    description: 'Write a durable project/global Markdown memory item. Use only after calling use_skill("auto-memory") in the same turn.',
    argNames: ['rootDir', 'layer', 'name', 'description', 'type', 'body'],
    scope: 'memory',
    requiredArgNames: ['rootDir', 'layer', 'name', 'description', 'type', 'body'],
  },
  saveCheckpoint: {
    fn: saveCheckpointTool,
    description: '保存代码存档或回退到指定版本。不传 revertTo 则 git commit 存档（修改前自动调用，不弹确认）；传 revertTo 则 git reset --hard 回退到指定 commit（需用户确认）。',
    argNames: ['rootDir', 'message', 'revertTo'],
    scope: 'write',
    requiredArgNames: ['rootDir'],
    argDescriptions: {
      message: '存档描述，不传自动生成时间戳',
      revertTo: '要回退到的 commit hash，不传表示保存存档',
    },
  },
}

// ── OpenAI Tool Definitions ───────────────────────────────────────────

export function toolDefsToOpenAI(scope: ToolScope): ToolDefinition[] {
  return toolEntriesToOpenAI(Object.entries(builtinToolRegistry), scope)
}

export function toolEntriesToOpenAI(
  entries: ReadonlyArray<readonly [string, ToolDef]>,
  scope: ToolScope,
): ToolDefinition[] {
  return entries
    .filter(([, def]) => {
      const allowedScopes: ToolScope[] = scope === 'read' ? ['read'] : ['read', 'write', 'memory']
      return allowedScopes.includes(def.scope)
    })
    .map(([name, def]) => {
      const properties: Record<string, { type: string; description: string }> = {}
      for (const arg of def.argNames) {
        properties[arg] = {
          type: 'string',
          description: def.argDescriptions?.[arg] ?? (arg === 'rootDir' ? '项目根目录' : arg),
        }
      }
      const required = def.requiredArgNames ?? def.argNames
      return {
        type: 'function' as const,
        function: {
          name,
          description: def.description,
          parameters: {
            type: 'object' as const,
            properties,
            required,
          },
        },
      }
    })
}

// ── Execute Tool ────────────────────────────────────────────────────

export async function executeToolResult(
  name: string,
  args: Record<string, string>,
  allowedPaths: string[],
  designConfirmed?: boolean,
  signal?: AbortSignal,
  options?: ExecuteToolOptions,
): Promise<ToolResult> {
  const tool = builtinToolRegistry[name]
  if (!tool) return toolFailure('UNKNOWN_TOOL', `未知工具 "${name}"`)
  return executeToolDefinitionResult(tool, name, args, allowedPaths, designConfirmed, signal, options)
}

export async function executeTool(
  name: string,
  args: Record<string, string>,
  allowedPaths: string[],
  designConfirmed?: boolean,
  signal?: AbortSignal,
  options?: ExecuteToolOptions,
): Promise<string> {
  return toolResultToLegacyOutput(await executeToolResult(name, args, allowedPaths, designConfirmed, signal, options))
}

export async function executeToolDefinition(
  tool: ToolDef,
  name: string,
  args: Record<string, string>,
  allowedPaths: string[],
  designConfirmed?: boolean,
  signal?: AbortSignal,
  options?: ExecuteToolOptions,
): Promise<string> {
  return toolResultToLegacyOutput(await executeToolDefinitionResult(tool, name, args, allowedPaths, designConfirmed, signal, options))
}

export async function executeToolDefinitionResult(
  tool: ToolDef,
  name: string,
  args: Record<string, string>,
  allowedPaths: string[],
  designConfirmed?: boolean,
  signal?: AbortSignal,
  options?: ExecuteToolOptions,
): Promise<ToolResult> {
  if (process.env.AGENT_EVAL_LOCAL_ONLY === '1' && REMOTE_SIDE_EFFECT_TOOLS.has(name)) {
    return toolFailure(
      'REMOTE_SIDE_EFFECT_BLOCKED',
      `本地评测模式已阻断远程工具 "${name}"，未执行任何 GitHub 副作用操作。`,
    )
  }

  if (signal?.aborted) return toolFailure('ABORTED', '工具执行已取消')
  const effectiveArgs = applyRepositoryDefaults(name, args, options?.repository)

  // All file writes, command execution and remote operations share one gate.
  if (tool.scope === 'write' && !designConfirmed) {
    return toolFailure(
      'PERMISSION_DENIED',
      '当前未确认方案，请先向用户说明修改方案，等待用户确认后再执行副作用操作。',
    )
  }

  if (tool.scope === 'memory' && !options?.turnLoadedSkills?.has('auto-memory')) {
    return toolFailure('PERMISSION_DENIED', 'writeMemory 只能在本轮先调用 use_skill("auto-memory") 后执行。')
  }

  // 校验 rootDir（如果工具有此参数）
  const rootDir = effectiveArgs.rootDir

  // Helper: validate a single path argument
  const validatePathArg = (val: string | undefined, argName: string): string | null => {
    if (!val) return null
    if (!isAbsolute(val)) {
      return `参数 "${argName}" 必须是绝对路径，当前值为 "${val}"。当前可操作目录：${allowedPaths.join(', ')}`
    }
    if (!isInsideAllowedPaths(val, allowedPaths)) {
      return `路径 "${val}" 不在可操作目录内。当前可操作目录：${allowedPaths.join(', ')}`
    }
    return null
  }

  if (rootDir) {
    const err = validatePathArg(rootDir, 'rootDir')
    if (err) return toolFailure('PATH_OUTSIDE_ALLOWED', err)
  }

  // 校验路径参数：必须是绝对路径且在可操作目录内
  for (const argName of tool.pathArgNames ?? []) {
    const err = validatePathArg(effectiveArgs[argName], argName)
    if (err) return toolFailure('PATH_OUTSIDE_ALLOWED', err)
  }

  // 必填参数校验
  const requiredArgNames = tool.requiredArgNames ?? tool.argNames
  for (const argName of requiredArgNames) {
    if (!effectiveArgs[argName] || effectiveArgs[argName].trim() === '') {
      return toolFailure('INVALID_ARGUMENTS', `工具 "${name}" 缺少必需参数 "${argName}"`)
    }
  }

  try {
    const effectiveRootDir = rootDir || allowedPaths[0]
    const argValues = tool.argNames
      .filter((n) => n !== 'rootDir') // rootDir injected separately above
      .map((n) => effectiveArgs[n] ?? '')

    const output = tool.withSignal
      ? await tool.withSignal(effectiveRootDir, argValues, signal)
      : await tool.fn(effectiveRootDir, ...argValues)
    return toolResultFromLegacyOutput(output)
  } catch (e: unknown) {
    if (e instanceof CommandError) {
      const code = e.kind === 'aborted' ? 'ABORTED' : e.kind === 'timeout' ? 'TIMEOUT'
        : e.kind === 'output-limit' ? 'OUTPUT_LIMIT' : e.code === 'ENOENT' ? 'COMMAND_NOT_FOUND'
        : e.kind === 'exit' ? 'COMMAND_FAILED' : 'TOOL_EXECUTION_FAILED'
      return toolFailure(code, e.message, e.kind === 'timeout', { stdout: e.stdout, stderr: e.stderr, exitCode: e.exitCode })
    }
    const message = e instanceof Error ? e.message : String(e)
    const commandMissing = /(?:spawn\s+\S+\s+ENOENT|command not found|不是内部或外部命令)/i.test(message)
    const timedOut = /timed?\s*out|ETIMEDOUT/i.test(message)
    return toolFailure(
      commandMissing ? 'COMMAND_NOT_FOUND' : timedOut ? 'TIMEOUT' : 'TOOL_EXECUTION_FAILED',
      message,
      timedOut,
    )
  }
}
