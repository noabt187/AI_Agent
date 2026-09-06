import {
  Component,
  createElement,
  useCallback,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import React from 'react'
import type { BrowserSlotService } from './slots'

export interface SlotOutletProps {
  runtime: { slots: BrowserSlotService }
  name: string
  sessionId: string
  owner?: Record<string, unknown>
}

export function SlotOutlet({ runtime, name, sessionId, owner = {} }: SlotOutletProps) {
  const subscribe = useCallback((listener: () => void) => runtime.slots.subscribe(name, listener), [name, runtime])
  const getSnapshot = useCallback(() => runtime.slots.entries(name), [name, runtime])
  const entries = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return <>
    {entries.map(entry => {
      const injected = entry.inject?.(sessionId) ?? {}
      return (
        <SlotErrorBoundary key={entry.id} entryId={entry.id}>
          {createElement(entry.component, { ...owner, ...injected })}
        </SlotErrorBoundary>
      )
    })}
  </>
}

class SlotErrorBoundary extends Component<
  { entryId: string; children: ReactNode },
  { error?: Error }
> {
  state: { error?: Error } = {}

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`slots: entry "${this.props.entryId}" failed to render`, error, info)
  }

  render(): ReactNode {
    if (this.state.error !== undefined) {
      return <span role="alert" data-plugin-error={this.props.entryId}>
        插件 {this.props.entryId} 渲染失败：{this.state.error.message}
      </span>
    }
    return this.props.children
  }
}
