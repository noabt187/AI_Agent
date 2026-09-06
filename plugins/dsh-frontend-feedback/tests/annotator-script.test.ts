import assert from 'node:assert/strict'
import test from 'node:test'
import { ANNOTATOR_SCRIPT } from '../src/annotator-script.ts'
import { installBrowserDom } from './helpers/browser-dom.ts'

test('image-slot clicks take priority over DOM annotation modes', async (t) => {
  const browser = installBrowserDom()
  const observers: MutationObserver[] = []
  const BrowserMutationObserver = globalThis.MutationObserver
  Object.defineProperty(globalThis, 'MutationObserver', {
    configurable: true,
    writable: true,
    value: class extends BrowserMutationObserver {
      constructor(callback: MutationCallback) {
        super(callback)
        observers.push(this)
      }
    },
  })
  t.after(() => {
    for (const observer of observers) observer.disconnect()
    browser.cleanup()
  })

  browser.document.body.innerHTML = `
    <section data-pagecraft-slide-id="slide-02">
      <figure data-pagecraft-image-slot="slide-02-architecture" data-pagecraft-slot-label="系统架构图"></figure>
    </section>
  `

  const messages: unknown[] = []
  Object.defineProperty((browser.window as any).parent, 'postMessage', {
    configurable: true,
    value(message: unknown) {
      messages.push(message)
    },
  })

  new Function(ANNOTATOR_SCRIPT)()
  browser.window.dispatchEvent(new (browser.window as any).MessageEvent('message', {
    data: { type: 'dsh-frontend-feedback-set-mode', mode: 'element' },
  }))

  const slot = browser.document.querySelector<HTMLElement>('[data-pagecraft-image-slot]')
  assert.ok(slot)
  slot.dispatchEvent(new (browser.window as any).MouseEvent('click', {
    bubbles: true,
    button: 0,
    cancelable: true,
  }))
  await new Promise(resolve => setTimeout(resolve, 25))

  const slotMessages = messages.filter((message: any) => message.type === 'dsh-pagecraft-image-slot-selected') as any[]
  assert.equal(slotMessages.length, 1)
  assert.deepEqual({
    type: slotMessages[0].type,
    slotId: slotMessages[0].slotId,
    label: slotMessages[0].label,
    slideId: slotMessages[0].slideId,
  }, {
    type: 'dsh-pagecraft-image-slot-selected',
    slotId: 'slide-02-architecture',
    label: '系统架构图',
    slideId: 'slide-02',
  })
  assert.equal(messages.some((message: any) => message.type === 'dsh-frontend-feedback-selected'), false)
})
