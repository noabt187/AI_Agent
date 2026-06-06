import { resolve, relative, sep } from 'node:path'

export function isInsideAllowedPaths(targetPath: string, allowedPaths: string[]): boolean {
  const resolvedTarget = resolve(targetPath)
  for (const allowed of allowedPaths) {
    const resolvedAllowed = resolve(allowed)
    const rel = relative(resolvedAllowed, resolvedTarget)
    if (!rel.startsWith('..') && rel !== '..') {
      return true
    }
  }
  return false
}

export function assertInsideAllowedPaths(targetPath: string, allowedPaths: string[]): void {
  if (!isInsideAllowedPaths(targetPath, allowedPaths)) {
    throw new Error(`路径越界："${targetPath}" 不在允许的操作目录内`)
  }
}
