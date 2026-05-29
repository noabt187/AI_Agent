import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve, relative } from 'node:path'

export type RetrievedFile = {
  filePath: string
  score: number
  content: string
}

const SUPPORTED_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.html', '.css', '.json', '.md'])
const IGNORE_DIRS = ['node_modules', '.git', 'dist', 'state']

function isSupportedFile(name: string): boolean {
  const ext = name.slice(name.lastIndexOf('.'))
  return SUPPORTED_EXT.has(ext)
}

function shouldIgnoreDir(name: string): boolean {
  return IGNORE_DIRS.includes(name)
}

async function collectAllFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir)
  const results: string[] = []
  for (const entry of entries) {
    if (shouldIgnoreDir(entry)) continue
    const fullPath = resolve(dir, entry)
    const s = await stat(fullPath)
    if (s.isDirectory()) {
      results.push(...(await collectAllFiles(fullPath)))
    } else if (isSupportedFile(entry)) {
      results.push(fullPath)
    }
  }
  return results
}

function calcScore(filePath: string, content: string, keywords: string[]): number {
  let score = 0
  const lowerPath = filePath.toLowerCase()
  const lowerContent = content.toLowerCase()
  for (const kw of keywords) {
    const lowerKw = kw.toLowerCase()
    if (lowerPath.includes(lowerKw)) score += 10
    const count = (lowerContent.match(new RegExp(lowerKw, 'g')) || []).length
    score += count
  }
  return score
}

export async function retrieveRelevantFiles(rootDir: string, requirement: string, topK = 5): Promise<RetrievedFile[]> {
  const allFiles = await collectAllFiles(rootDir)
  const keywords = requirement.split(/\s+/).filter((kw) => kw.length > 1)

  const scored: RetrievedFile[] = []
  for (const fullPath of allFiles) {
    const content = await readFile(fullPath, 'utf8')
    const score = calcScore(fullPath, content, keywords)
    if (score > 0) {
      scored.push({
        filePath: relative(rootDir, fullPath),
        score,
        content,
      })
    }
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, topK)
}
