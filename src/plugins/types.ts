import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

export interface DshBundleManifest {
  patch: string
}

export interface DshProfileManifest {
  bundles?: string[]
}

export interface DshClientManifest {
  platform: string
  inject?: string[]
  immediately?: boolean
}

export interface ProfileManifest {
  name?: string
  private?: boolean
  version?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  dsh?: {
    bundle?: DshBundleManifest
    profile?: DshProfileManifest
    client?: DshClientManifest
  }
}

export interface ProfileLayer {
  packageName: string
  packageDir: string
  patchPath: string
  patches: PatchOptions[]
}

export interface LoadedProfile {
  name: string
  dir: string
  manifest: ProfileManifest
  layers: ProfileLayer[]
  userPatchPath: string
  userPatches: PatchOptions[]
}

export type { EntryOptions, PatchOptions }
