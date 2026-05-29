import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export async function readTextFile(rootDir: string, relativePath: string): Promise<string> {
  const fullPath = resolve(rootDir, relativePath)
  return readFile(fullPath, 'utf8')
}

export async function writeTextFile(rootDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = resolve(rootDir, relativePath)
  await writeFile(fullPath, content, 'utf8')
}
