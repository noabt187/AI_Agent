import { JSDOM } from 'jsdom'
import React from 'react'

type InstalledGlobal = {
  key: PropertyKey
  descriptor?: PropertyDescriptor
}

export function installBrowserDom(): { window: Window; document: Document; cleanup(): void } {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://127.0.0.1:4173/',
  })
  const browserWindow = dom.window
  const target = globalThis as typeof globalThis & Record<PropertyKey, unknown>
  const installed: InstalledGlobal[] = []

  const install = (key: PropertyKey, value: unknown) => {
    installed.push({ key, descriptor: Object.getOwnPropertyDescriptor(target, key) })
    Object.defineProperty(target, key, { configurable: true, writable: true, value })
  }

  for (const key of [
    'window',
    'self',
    'document',
    'navigator',
    'Node',
    'Element',
    'HTMLElement',
    'HTMLImageElement',
    'HTMLButtonElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'Event',
    'CustomEvent',
    'KeyboardEvent',
    'MouseEvent',
    'PointerEvent',
    'FocusEvent',
    'MutationObserver',
    'DOMRect',
    'localStorage',
    'sessionStorage',
  ] as const) {
    const value = browserWindow[key as keyof typeof browserWindow]
      ?? (key === 'PointerEvent' ? browserWindow.MouseEvent : undefined)
    if (value !== undefined) install(key, value)
  }

  install('getComputedStyle', browserWindow.getComputedStyle.bind(browserWindow))
  install('requestAnimationFrame', browserWindow.requestAnimationFrame.bind(browserWindow))
  install('cancelAnimationFrame', browserWindow.cancelAnimationFrame.bind(browserWindow))
  install('IS_REACT_ACT_ENVIRONMENT', true)
  install('React', React)
  install('Window', browserWindow.Window)
  browserWindow.Range.prototype.getClientRects = () => [] as any
  browserWindow.Range.prototype.getBoundingClientRect = () => new browserWindow.DOMRect()
  browserWindow.confirm = () => true

  return {
    window: browserWindow as unknown as Window,
    document: browserWindow.document,
    cleanup() {
      browserWindow.close()
      for (const { key, descriptor } of installed.reverse()) {
        if (descriptor) Object.defineProperty(target, key, descriptor)
        else delete target[key]
      }
    },
  }
}
