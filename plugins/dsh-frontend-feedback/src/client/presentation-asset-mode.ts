import type { PresentationWorkspaceSummary } from '../presentation-workspace.ts'

export type PresentationAssetMode = 'project' | 'legacy' | 'unavailable'

export function resolvePresentationAssetMode(
  summary: PresentationWorkspaceSummary,
  legacyJobId: string | null,
): PresentationAssetMode {
  if (summary.available && summary.manifest !== undefined) return 'project'
  if (!summary.available && legacyJobId !== null) return 'legacy'
  return 'unavailable'
}
