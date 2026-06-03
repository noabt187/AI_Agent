import { readdir, stat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { collectFiles, patternToRegex } from '../utils/fileUtils.js'

export async function readTextFile(rootDir: string, relativePath: string): Promise<string> {
  return readFile(resolve(rootDir, relativePath), 'utf8')
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

export { listDirectory, searchFiles, searchContent }
