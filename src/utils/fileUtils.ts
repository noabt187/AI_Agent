import { readdir, stat, readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'state'])
const SUPPORTED_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.html', '.css', '.json', '.md', '.vue', '.svelte',
  '.py', '.java', '.kt', '.go', '.rs', '.sh', '.ps1',
  '.yaml', '.yml', '.toml',
])
const MAX_SEARCHABLE_FILE_BYTES = 2 * 1024 * 1024

export async function collectFiles(dir: string, prefix = ''): Promise<string[]> {
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
      if (SUPPORTED_EXT.has(ext) && s.size <= MAX_SEARCHABLE_FILE_BYTES) {
        results.push(rel)
      }
    }
  }
  return results
}

export function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

export { readFile }
