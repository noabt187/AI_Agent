import { installBrowserDom as installDom } from './browserDom.js'
import React from 'react'

export function installBrowserDom() {
  const dom = installDom()
  const browser = dom.window as Window & { Window: typeof Window }
  const descriptors = new Map<string, PropertyDescriptor | undefined>()
  const install = (key: string, value: unknown) => {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable:true, writable:true, value })
  }
  install('Window', browser.Window)
  install('React', React)
  return { window:browser as unknown as Window, document:browser.document, cleanup() {
    dom.cleanup()
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  } }
}
