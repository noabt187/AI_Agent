import { resolve, relative, sep } from 'node:path'

export function assertInsideRoot(rootDir: string, targetPath: string): void {
  const resolvedRoot = resolve(rootDir)
  const resolvedTarget = resolve(rootDir, targetPath)
  const rel = relative(resolvedRoot, resolvedTarget)
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`路径越界："${targetPath}" 超出了项目根目录`)
  }
}

export function assertInsideAllowedPaths(targetPath: string, allowedPaths: string[]): void {
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
