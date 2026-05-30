import { readdir, stat, readFile, writeFile as fsWriteFile, unlink, mkdir } from 'node:fs/promises'
import { resolve, relative, extname, sep, dirname } from 'node:path'
import { readTextFile } from '../../tools/fileTools.js'

import type { ToolDefinition } from '../../llm/types.js'

export type ToolScope = 'read' | 'write'

// ── Tool Definitions ────────────────────────────────────────────────

export type ToolFn = (rootDir: string, ...args: string[]) => Promise<string>

export type ToolDef = {
  fn: ToolFn
  description: string
  argNames: string[]
  scope: ToolScope
}

async function listDirectory(rootDir: string, dirPath: string): Promise<string> {
  const fullPath = resolve(rootDir, dirPath)
  const entries = await readdir(fullPath)
  const lines: string[] = []
  for (const entry of entries.sort()) {
    const entryPath = resolve(fullPath, entry)
    const s = await stat(entryPath)
    lines.push(s.isDirectory() ? `${entry}/` : entry)
  }
  return lines.join('\n')
}

async function searchFiles(rootDir: string, pattern: string): Promise<string> {
  const allFiles = await collectFiles(rootDir)
  const regex = patternToRegex(pattern)
  const matched = allFiles.filter((f) => regex.test(f))
  if (matched.length === 0) return '没有找到匹配的文件'
  return matched.join('\n')
}

async function searchContent(rootDir: string, keyword: string): Promise<string> {
  const allFiles = await collectFiles(rootDir)
  const results: string[] = []
  const lowerKw = keyword.toLowerCase()

  for (const relPath of allFiles) {
    try {
      const content = await readFile(resolve(rootDir, relPath), 'utf8')
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(lowerKw)) {
          results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`)
          if (results.length >= 50) return results.join('\n')
        }
      }
    } catch {}
  }

  return results.length > 0 ? results.join('\n') : '没有找到匹配的内容'
}

async function writeFileTool(rootDir: string, relativePath: string, content: string): Promise<string> {
  const fullPath = resolve(rootDir, relativePath)
  await mkdir(dirname(fullPath), { recursive: true })
  await fsWriteFile(fullPath, content, 'utf8')
  return `已写入: ${relativePath}`
}

async function deleteFileTool(rootDir: string, relativePath: string): Promise<string> {
  const fullPath = resolve(rootDir, relativePath)
  await unlink(fullPath)
  return `已删除: ${relativePath}`
}

// ── File Collection ─────────────────────────────────────────────────

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'state'])
const SUPPORTED_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.html', '.css', '.json', '.md', '.vue', '.svelte'])

async function collectFiles(dir: string, prefix = ''): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const results: string[] = []
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry)) continue
    const fullPath = resolve(dir, entry)
    let s: Awaited<ReturnType<typeof stat>>
    try {
      s = await stat(fullPath)
    } catch {
      continue
    }
    const rel = prefix ? `${prefix}/${entry}` : entry
    if (s.isDirectory()) {
      results.push(...(await collectFiles(fullPath, rel)))
    } else {
      const ext = extname(entry)
      if (SUPPORTED_EXT.has(ext)) {
        results.push(rel)
      }
    }
  }
  return results
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

// ── Registry ────────────────────────────────────────────────────────

export const toolRegistry: Record<string, ToolDef> = {
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
        properties[arg] = { type: 'string', description: arg === 'rootDir' ? '项目根目录' : arg }
      }
      return {
        type: 'function' as const,
        function: {
          name,
          description: def.description,
          parameters: {
            type: 'object' as const,
            properties,
            required: def.argNames,
          },
        },
      }
    })
}

// ── Path Validation ─────────────────────────────────────────────────

function assertInsideRoot(rootDir: string, targetPath: string): void {
  const resolvedRoot = resolve(rootDir)
  const resolvedTarget = resolve(rootDir, targetPath)
  const rel = relative(resolvedRoot, resolvedTarget)
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('..')) {
    throw new Error(`路径越界："${targetPath}" 超出了项目根目录`)
  }
}

function assertInsideAllowedPaths(targetPath: string, allowedPaths: string[]): void {
  const resolvedTarget = resolve(targetPath)
  for (const allowed of allowedPaths) {
    const resolvedAllowed = resolve(allowed)
    const rel = relative(resolvedAllowed, resolvedTarget)
    if (!rel.startsWith('..') && rel !== '..') {
      return // inside this allowed path
    }
  }
  throw new Error(`路径越界："${targetPath}" 不在允许的操作目录内`)
}

// ── Execute Tool ────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  args: Record<string, string>,
  allowedPaths?: string[],
  scope: ToolScope = 'read',
): Promise<string> {
  const tool = toolRegistry[name]
  if (!tool) return `错误：未知工具 "${name}"`
  if (scope === 'read' && tool.scope !== 'read') {
    return `错误：工具 "${name}" 不在当前节点的可用范围内（只读模式）`
  }
  try {
    const rootDir = args.rootDir ?? '.'
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

      // All other params are required
      if (!val || val.trim() === '') {
        return `错误：工具 "${name}" 缺少必需参数 "${argName}"`
      }
      assertInsideRoot(rootDir, val)
    }

    // For write-scope tools, validate against allowedPaths
    if (tool.scope === 'write' && allowedPaths) {
      for (const argName of tool.argNames) {
        if (argName !== 'rootDir' && argName !== 'content' && args[argName]) {
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
