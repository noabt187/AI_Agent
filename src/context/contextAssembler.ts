import type { ProjectMeta } from './projectMetaLoader.js'
import type { RetrievedFile } from './codeRetriever.js'

export function assembleContext(
  meta: ProjectMeta,
  retrievedFiles: RetrievedFile[],
  maxChars = 12000,
): string {
  const parts: string[] = []
  if (meta.projectIntroContent) {
    parts.push('=== Project Introduction ===')
    parts.push(meta.projectIntroContent)
  }
  if (meta.directoryTree) {
    parts.push('\n=== Project Directory Structure ===')
    parts.push(meta.directoryTree)
  }
  if (meta.packageJsonContent) {
    parts.push('\n=== package.json ===')
    parts.push(meta.packageJsonContent)
  }
  if (meta.readmeContent) {
    parts.push('\n=== README ===')
    parts.push(meta.readmeContent)
  }

  let totalChars = parts.join('\n').length

  for (const file of retrievedFiles) {
    const filePart = `\n=== File: ${file.filePath} ===\n${file.content}`
    const fileChars = filePart.length
    if (totalChars + fileChars > maxChars) {
      break
    }
    parts.push(filePart)
    totalChars += fileChars
  }

  return parts.join('\n')
}
