import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BrowserSlotService } from '../web/src/plugins/slots.js'
import { SlotOutlet } from '../web/src/plugins/SlotOutlet.js'

const PageCraftProbe = () => <button type="button">PageCraft</button>

test('slot injection waits for declaration, renders in order, and tears down', async (t) => {
  const ctx = new Context()
  await ctx.plugin(BrowserSlotService)
  t.after(() => ctx.fiber.dispose())
  const slots = ctx.slots
  const disposeInject = slots.inject('conversation.input.left', () =>
    slots.register({ name: 'conversation.input.left', id: 'pagecraft', order: 30 }, PageCraftProbe))
  assert.deepEqual(slots.entries('conversation.input.left'), [])

  const disposeDeclare = slots.declare('conversation.input.left', { kind: 'list', scope: 'session' })
  slots.register({ name: 'conversation.input.left', id: 'first', order: 10 }, () => <span>First</span>)
  assert.deepEqual(slots.entries('conversation.input.left').map(entry => entry.id), ['first', 'pagecraft'])
  const html = renderToStaticMarkup(
    <SlotOutlet runtime={{ slots }} name="conversation.input.left" sessionId="session-001" owner={{}} />,
  )
  assert.match(html, /First.*PageCraft/)
  disposeDeclare()
  assert.deepEqual(slots.entries('conversation.input.left'), [])
  disposeInject()
})

test('disposing a contributing Cordis fiber removes its active slot entry', async (t) => {
  const ctx = new Context()
  await ctx.plugin(BrowserSlotService)
  t.after(() => ctx.fiber.dispose())
  ctx.slots.declare('conversation.input.left', { kind: 'list', scope: 'session' })
  const fiber = ctx.plugin({
    inject: ['slots'],
    apply(pluginCtx: Context) {
      pluginCtx.slots.inject('conversation.input.left', () => pluginCtx.slots.register({
        name: 'conversation.input.left',
        id: 'pagecraft',
      }, PageCraftProbe))
    },
  })
  await fiber.await()
  assert.equal(ctx.slots.entries('conversation.input.left').length, 1)
  await fiber.dispose()
  assert.equal(ctx.slots.entries('conversation.input.left').length, 0)
})
