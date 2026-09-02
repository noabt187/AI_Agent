import { Service, type Context } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import type { SlotRegistration, SlotSpec, StoredSlotEntry } from './types'

type Dispose = () => void

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: BrowserSlotService
  }
}

export class BrowserSlotService extends Service {
  private readonly declarations = new Map<string, { spec: SlotSpec; epoch: number }>()
  private readonly entryLists = new Map<string, readonly StoredSlotEntry[]>()
  private readonly declarationListeners = new Map<string, Set<() => void>>()
  private readonly entryListeners = new Map<string, Set<() => void>>()
  private nextEpoch = 1
  private nextSequence = 1

  constructor(ctx: Context) {
    super(ctx, 'slots')
  }

  declare(name: string, spec: SlotSpec): Dispose {
    validateSlotName(name)
    validateSlotSpec(name, spec)
    const ctx = this.ctx
    const dispose = ctx.effect(() => {
      if (this.declarations.has(name)) throw new Error(`slots: slot "${name}" is already declared`)
      const declaration = { spec: { ...spec }, epoch: this.nextEpoch++ }
      this.declarations.set(name, declaration)
      this.notifyDeclaration(name)
      return () => {
        if (this.declarations.get(name) !== declaration) return
        this.declarations.delete(name)
        if ((this.entryLists.get(name)?.length ?? 0) > 0) this.setEntries(name, [])
        this.notifyDeclaration(name)
      }
    }, `slots.declare(${JSON.stringify(name)})`)
    return () => { void dispose() }
  }

  inject(name: string, install: () => Dispose): Dispose {
    validateSlotName(name)
    if (typeof install !== 'function') throw new Error(`slots: injection for "${name}" must be a function`)
    const ctx = this.ctx
    const disposeController = ctx.effect(() => {
      let active: Dispose | undefined
      let epoch: number | undefined
      let stopped = false

      const reconcile = (): void => {
        if (stopped) return
        const declaration = this.declarations.get(name)
        if (active !== undefined && epoch === declaration?.epoch) return
        active?.()
        active = undefined
        epoch = undefined
        if (declaration === undefined) return
        const dispose = ctx.effect(install, `slots.inject(${JSON.stringify(name)}): declaration`)
        active = () => { void dispose() }
        epoch = declaration.epoch
      }

      const listeners = this.declarationListeners.get(name) ?? new Set<() => void>()
      this.declarationListeners.set(name, listeners)
      listeners.add(reconcile)
      reconcile()
      return () => {
        if (stopped) return
        stopped = true
        listeners.delete(reconcile)
        active?.()
      }
    }, `slots.inject(${JSON.stringify(name)})`)
    return () => { void disposeController() }
  }

  register(
    options: SlotRegistration,
    component: ComponentType<Record<string, unknown>>,
  ): Dispose {
    validateRegistration(options, component)
    const declaration = this.declarations.get(options.name)
    if (declaration === undefined) throw new Error(`slots: slot "${options.name}" is not declared`)
    const ctx = this.ctx
    const dispose = ctx.effect(() => {
      const current = this.entryLists.get(options.name) ?? []
      if (current.some(entry => entry.id === options.id)) {
        throw new Error(`slots: slot "${options.name}" already contains entry "${options.id}"`)
      }
      if (declaration.spec.kind === 'single' && current.length > 0) {
        throw new Error(`slots: single slot "${options.name}" already has a registration`)
      }
      const entry: StoredSlotEntry = {
        ...options,
        component,
        sequence: this.nextSequence++,
      }
      this.setEntries(options.name, [...current, entry])
      return () => {
        const entries = this.entryLists.get(options.name) ?? []
        if (!entries.includes(entry)) return
        this.setEntries(options.name, entries.filter(item => item !== entry))
      }
    }, `slots.register(${JSON.stringify(options.name)}, ${JSON.stringify(options.id)})`)
    return () => { void dispose() }
  }

  entries(name: string): readonly StoredSlotEntry[] {
    return this.entryLists.get(name) ?? EMPTY_ENTRIES
  }

  subscribe(name: string, listener: () => void): Dispose {
    const listeners = this.entryListeners.get(name) ?? new Set<() => void>()
    this.entryListeners.set(name, listeners)
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  spec(name: string): SlotSpec | undefined {
    const spec = this.declarations.get(name)?.spec
    return spec === undefined ? undefined : { ...spec }
  }

  private setEntries(name: string, entries: readonly StoredSlotEntry[]): void {
    const ordered = [...entries].sort((left, right) =>
      (left.order ?? 0) - (right.order ?? 0) || left.sequence - right.sequence)
    this.entryLists.set(name, Object.freeze(ordered))
    for (const listener of [...this.entryListeners.get(name) ?? []]) listener()
  }

  private notifyDeclaration(name: string): void {
    for (const listener of [...this.declarationListeners.get(name) ?? []]) listener()
  }
}

const EMPTY_ENTRIES: readonly StoredSlotEntry[] = Object.freeze([])

function validateSlotName(name: string): void {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('slots: slot name must be a non-empty string')
}

function validateSlotSpec(name: string, spec: SlotSpec): void {
  if (!spec || (spec.kind !== 'single' && spec.kind !== 'list')) {
    throw new Error(`slots: slot "${name}" has an invalid kind`)
  }
  if (spec.scope !== 'root' && spec.scope !== 'session') {
    throw new Error(`slots: slot "${name}" has an invalid scope`)
  }
}

function validateRegistration(
  options: SlotRegistration,
  component: ComponentType<Record<string, unknown>>,
): void {
  if (!options || typeof options.name !== 'string' || typeof options.id !== 'string' || options.id === '') {
    throw new Error('slots: registration requires non-empty name and id')
  }
  if (typeof component !== 'function' && typeof component !== 'object') {
    throw new Error(`slots: entry "${options.id}" has an invalid React component`)
  }
}

export const slotsPlugin = BrowserSlotService
export default BrowserSlotService
