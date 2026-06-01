import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

export type DirectoryEntry = {
  name: string
  path: string
}

export type DirectoryListing = {
  path: string
  parentPath: string | null
  entries: DirectoryEntry[]
}

export async function listDirectories(rawPath?: string): Promise<DirectoryListing> {
  const currentPath = resolve(rawPath && rawPath.trim() ? rawPath : homedir())
  const info = await stat(currentPath)
  if (!info.isDirectory()) {
    throw new Error('路径不是文件夹')
  }

  const entries = await readdir(currentPath, { withFileTypes: true })
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: resolve(currentPath, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const parentPath = dirname(currentPath)
  return {
    path: currentPath,
    parentPath: parentPath === currentPath ? null : parentPath,
    entries: dirs,
  }
}
