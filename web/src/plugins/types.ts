import type { ComponentType } from 'react'

export interface TextContent {
  type: 'text'
  text: string
}

export type PromptResult = { ok: true } | { ok: false; error: { message: string } }

export interface SlotSpec {
  kind: 'single' | 'list'
  scope: 'root' | 'session'
}

export interface SlotRegistration {
  name: string
  id: string
  order?: number
  label?: (() => string) | string
  inject?: (sessionId: string) => Record<string, unknown>
}

export interface StoredSlotEntry extends SlotRegistration {
  component: ComponentType<Record<string, unknown>>
  sequence: number
}

export interface ClientManifestRow {
  id: string
  url: string
  rev: string
  inject?: string[]
  immediately?: boolean
}

export interface ClientManifest {
  revision: string
  modules: ClientManifestRow[]
}

export interface ClientPluginHandoff {
  id: string
  factory(require: (specifier: string) => unknown): Record<string, unknown>
}

declare global {
  interface Window {
    __ModuleLoader__?: {
      load(handoff: ClientPluginHandoff): void
    }
  }

  // Node-based integration tests execute the same classic plugin wrappers on
  // globalThis, while browsers expose globalThis and window as one object.
  var __ModuleLoader__: Window['__ModuleLoader__']
}
