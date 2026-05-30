import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export async function readTextFile(rootDir: string, relativePath: string): Promise<string> {
  const fullPath = resolve(rootDir, relativePath)
  return readFile(fullPath, 'utf8')
}
