import { writeFile, unlink, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'

async function writeFileTool(rootDir: string, relativePath: string, content: string): Promise<string> {
  const fullPath = resolve(rootDir, relativePath)
  await mkdir(dirname(fullPath), { recursive: true })
  await writeFile(fullPath, content, 'utf8')
  return `已写入: ${relativePath}`
}

async function deleteFileTool(rootDir: string, relativePath: string): Promise<string> {
  const fullPath = resolve(rootDir, relativePath)
  await unlink(fullPath)
  return `已删除: ${relativePath}`
}

export { writeFileTool, deleteFileTool }
