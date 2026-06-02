import { resolve } from 'node:path'
import { readTextFile, listDirectory, searchFiles, searchContent } from './fileRead.js'
import { writeFileTool, deleteFileTool } from './fileWrite.js'
import { execCommandTool } from './execCommand.js'
import { verifyCodeTool } from './verifyCode.js'
import { createPullRequestTool } from './createPullRequest.js'
import { forkRepositoryTool, cloneRepositoryTool } from './repositoryTools.js'
import { compressContextTool } from './compressContext.js'
import { assertInsideRoot, assertInsideAllowedPaths } from '../utils/pathUtils.js'
import type { ToolDefinition } from '../llm/types.js'

type ToolScope = 'read' | 'write'

type ToolFn = (rootDir: string, ...args: string[]) => Promise<string>

type ToolDef = {
  fn: ToolFn
  description: string
  argNames: string[]
  scope: ToolScope
  requiredArgNames?: string[]
  pathArgNames?: string[]
}

// ── Registry ────────────────────────────────────────────────────────

const toolRegistry: Record<string, ToolDef> = {
  readTextFile: {
    fn: readTextFile,
    description: '读取指定路径的文本文件内容',
    argNames: ['rootDir', 'relativePath'],
    scope: 'read',
  },
  listDirectory: {
    fn: listDirectory,
    description: '列出指定目录下的文件和文件夹',
    argNames: ['rootDir', 'dirPath'],
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
    description: '创建或覆盖写入文件（自动创建父目录）',
    argNames: ['rootDir', 'relativePath', 'content'],
    scope: 'write',
  },
  deleteFile: {
    fn: deleteFileTool,
    description: '删除指定文件（需要人工确认）',
    argNames: ['rootDir', 'relativePath'],
    scope: 'write',
  },
  execCommand: {
    fn: execCommandTool,
    description: '在项目目录下执行 shell 命令，用于运行 lint、test、build 等',
    argNames: ['rootDir', 'command'],
    scope: 'read',
  },
  verifyCode: {
    fn: verifyCodeTool,
    description: '验证代码质量：运行 lint/test/build + 跨栈一致性检查，changedFiles 为本次修改的文件列表（逗号分隔）',
    argNames: ['rootDir', 'changedFiles'],
    scope: 'read',
  },
  createPullRequest: {
    fn: createPullRequestTool,
    description: '把当前项目的本地改动提交到分支并创建 GitHub PR。repoUrl 是推送仓库，auto 读取 origin；prRepoUrl 是 PR 目标仓库，auto 表示同 repoUrl；draft 默认 true。参数: repoUrl,title,body,baseBranch,headBranch,commitMessage,draft,remote,prRepoUrl,headOwner',
    argNames: ['rootDir', 'repoUrl', 'title', 'body', 'baseBranch', 'headBranch', 'commitMessage', 'draft', 'remote', 'prRepoUrl', 'headOwner'],
    scope: 'write',
    requiredArgNames: ['rootDir'],
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
}

// ── Tool Descriptions ───────────────────────────────────────────────

export function getToolDescriptionsForScope(scope: ToolScope): string {
  return Object.entries(toolRegistry)
    .filter(([, def]) => scope === 'write' || def.scope === 'read')
    .map(([name, def]) => {
      const args = def.argNames.map((a) => `${a}: string`).join(', ')
      return `- ${name}(${args}): ${def.description}`
    })
    .join('\n')
}

// ── OpenAI Tool Definitions ───────────────────────────────────────────

export function toolDefsToOpenAI(scope: ToolScope): ToolDefinition[] {
  return Object.entries(toolRegistry)
    .filter(([, def]) => scope === 'write' || def.scope === 'read')
    .map(([name, def]) => {
      const properties: Record<string, { type: string; description: string }> = {}
      for (const arg of def.argNames) {
        properties[arg] = {
          type: 'string',
          description: arg === 'rootDir'
            ? '项目根目录'
            : (name === 'createPullRequest' && arg !== 'repoUrl' ? `${arg}，可传 auto 使用默认值` : arg),
        }
      }
      const required = def.requiredArgNames ?? (name === 'createPullRequest' ? ['rootDir'] : def.argNames)
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

// ── Non-path argument detection ─────────────────────────────────────

function isNonPathToolArg(toolName: string, argName: string): boolean {
  if (toolName === 'execCommand' && argName === 'command') return true
  if (toolName === 'verifyCode' && argName === 'changedFiles') return true
  if (toolName === 'createPullRequest') return true
  if (toolName === 'forkRepository') return true
  if (toolName === 'cloneRepository' && argName !== 'cloneParentDir') return true
  if (toolName === 'compressContext' && argName === 'sessionId') return true
  return false
}

// ── Execute Tool ────────────────────────────────────────────────────

export type WriteConfirmFn = (toolName: string, targetFile: string) => Promise<boolean>

export async function executeTool(
  name: string,
  args: Record<string, string>,
  allowedPaths?: string[],
  scope: ToolScope = 'read',
  designConfirmed?: boolean,
  onConfirmWrite?: WriteConfirmFn,
): Promise<string> {
  const tool = toolRegistry[name]
  if (!tool) return `错误：未知工具 "${name}"`
  if (scope === 'read' && tool.scope !== 'read') {
    return `错误：工具 "${name}" 不在当前节点的可用范围内（只读模式）`
  }

  // 写操作确认检查
  if (tool.scope === 'write' && !designConfirmed) {
    const targetFile = args.relativePath || args.content?.slice(0, 50) || name
    if (onConfirmWrite) {
      const confirmed = await onConfirmWrite(name, targetFile)
      if (!confirmed) return `用户拒绝了此操作。请先向用户说明修改方案，用户确认后再执行。`
    } else {
      return `错误：当前未确认方案，请先向用户确认修改方案后再修改代码。`
    }
  }
  try {
    const rootDir = args.rootDir ?? '.'
    if (tool.scope === 'write' && allowedPaths) {
      assertInsideAllowedPaths(rootDir, allowedPaths)
    }
    const requiredArgNames = new Set(tool.requiredArgNames ?? tool.argNames)
    const pathArgNames = new Set(tool.pathArgNames ?? tool.argNames.filter((argName) => !isNonPathToolArg(name, argName)))

    for (const argName of tool.argNames) {
      if (argName === 'rootDir') continue
      const val = args[argName]

      // listDirectory with empty dirPath = list root directory
      if (name === 'listDirectory' && argName === 'dirPath' && (!val || val.trim() === '')) {
        args[argName] = '.' // default to root
        continue
      }

      // searchFiles with empty pattern = match all (use *)
      if (name === 'searchFiles' && argName === 'pattern' && (!val || val.trim() === '')) {
        return `错误：工具 "${name}" 缺少搜索模式（pattern 不能为空）`
      }

      // Some arguments are commands or metadata, not filesystem paths.
      if (isNonPathToolArg(name, argName)) {
        if (requiredArgNames.has(argName) && (!val || val.trim() === '')) {
          return `错误：工具 "${name}" 缺少必需参数 "${argName}"`
        }
        continue
      }

      // All other params are required
      if (requiredArgNames.has(argName) && (!val || val.trim() === '')) {
        return `错误：工具 "${name}" 缺少必需参数 "${argName}"`
      }
      if (val && pathArgNames.has(argName)) assertInsideRoot(rootDir, val)
    }

    // For write-scope tools, validate against allowedPaths
    if (tool.scope === 'write' && allowedPaths) {
      for (const argName of tool.argNames) {
        if (argName !== 'rootDir' && argName !== 'content' && args[argName] && pathArgNames.has(argName)) {
          const fullPath = resolve(rootDir, args[argName])
          assertInsideAllowedPaths(fullPath, allowedPaths)
        }
      }
    }

    const argValues = tool.argNames.map((n) => args[n] ?? '')
    return await tool.fn(rootDir, ...argValues.slice(1))
  } catch (e: unknown) {
    return `工具执行错误：${e instanceof Error ? e.message : String(e)}`
  }
}
