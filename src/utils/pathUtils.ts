import { resolve, relative } from 'node:path'

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

