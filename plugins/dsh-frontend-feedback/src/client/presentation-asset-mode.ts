import type { PresentationWorkspaceSummary } from '../presentation-workspace.ts'

export type PresentationAssetMode = 'project' | 'legacy' | 'unavailable'

export function resolvePresentationAssetMode(
  summary: PresentationWorkspaceSummary,
  presentationId: string | null,
): PresentationAssetMode {
  if (summary.presentationId !== presentationId) return 'unavailable'
  if (summary.available && summary.manifest?.presentationId === presentationId) return 'project'
  if (!summary.available && presentationId !== null) return 'legacy'
  return 'unavailable'
}
