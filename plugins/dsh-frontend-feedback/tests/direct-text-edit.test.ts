import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import {
  DirectTextEditService,
  type DomTextSelection,
} from '../lib/index.js'

async function directEditFixture(t: TestContext, source: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'pagecraft-direct-edit-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await mkdir(join(cwd, 'src'), { recursive: true })
  await writeFile(join(cwd, 'src', 'App.tsx'), source)
  return cwd
}

async function presentationFixture(t: TestContext, slides: Array<{ id: string; content: string }>): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'pagecraft-presentation-edit-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await writeFile(join(cwd, 'deck.json'), `${JSON.stringify({ slides }, null, 2)}\n`)
  return cwd
}

function selection(displayedText: string): DomTextSelection {
  return {
    pageUrl: 'http://localhost:5173/',
    framePath: [],
    selector: 'h1',
    fingerprint: `h1|${displayedText}`,
    displayedText,
    tagName: 'h1',
    attributes: {},
    nearbyText: [],
  }
}

function presentationSelection(displayedText: string, overrides: Partial<DomTextSelection> = {}): DomTextSelection {
  return {
    ...selection(displayedText),
    selector: 'section#slide-01 > div.layout-title > div.paper-title',
    fingerprint: `slide-01|div|paper-title|${displayedText}`,
    tagName: 'div',
    attributes: { class: 'paper-title' },
    slideId: 'slide-01',
    presentationElementPath: [0, 1],
    ...overrides,
  }
}

test('direct text transaction commits only after verified DOM text', async (t) => {
  const cwd = await directEditFixture(t, 'export const App=()=> <h1>旧标题</h1>\n')
  const service = new DirectTextEditService({ verificationTimeoutMs: 8_000, retentionMs: 120_000 })
  t.after(() => service.dispose())

  const started = await service.start(cwd, 'src', selection('旧标题'), '新标题')
  assert.match(await readFile(join(cwd, 'src', 'App.tsx'), 'utf8'), /新标题/)
  const result = await service.verify(cwd, {
    transactionId: started.transactionId,
    verified: true,
    observedText: '新标题',
  })
  assert.equal(result.status, 'committed')
})

test('failed verification rolls back only when written hash is still current', async (t) => {
  const cwd = await directEditFixture(t, 'export const App=()=> <h1>旧标题</h1>\n')
  const service = new DirectTextEditService()
  t.after(() => service.dispose())

  const started = await service.start(cwd, 'src', selection('旧标题'), '错误标题')
  const rolledBack = await service.verify(cwd, {
    transactionId: started.transactionId,
    verified: false,
    observedText: '旧标题',
  })
  assert.equal(rolledBack.status, 'rolled_back')
  assert.match(await readFile(join(cwd, 'src', 'App.tsx'), 'utf8'), /旧标题/)

  const second = await service.start(cwd, 'src', selection('旧标题'), '第二标题')
  await writeFile(join(cwd, 'src', 'App.tsx'), 'export const App=()=> <h1>外部修改</h1>\n')
  const conflict = await service.verify(cwd, {
    transactionId: second.transactionId,
    verified: false,
    observedText: '外部修改',
  })
  assert.equal(conflict.status, 'conflict')
  assert.match(await readFile(join(cwd, 'src', 'App.tsx'), 'utf8'), /外部修改/)
})

test('direct text edits preserve syntax escaping and reject stale selections', async (t) => {
  const cwd = await directEditFixture(t, "export const App=()=> <h1>{'旧标题'}</h1>\n")
  const service = new DirectTextEditService()
  t.after(() => service.dispose())

  const started = await service.start(cwd, 'src', selection('旧标题'), "新的 '标题'")
  assert.match(await readFile(join(cwd, 'src', 'App.tsx'), 'utf8'), /新的 \\'标题\\'/)
  await service.verify(cwd, { transactionId: started.transactionId, verified: false })
  await assert.rejects(
    () => service.start(cwd, 'src', selection('不存在的标题'), '不会写入'),
    (error: any) => error.code === 'TEXT_SOURCE_NOT_FOUND',
  )
})

test('direct text edit follows slideId into deck.json embedded HTML', async (t) => {
  const title = 'AppAgent-Claw: CLI Is All You Need for GUI Automation'
  const cwd = await presentationFixture(t, [
    {
      id: 'slide-01',
      content: '<div class="layout-title"><div class="top-bar"></div><div class="paper-title">AppAgent-Claw:<br>CLI Is All You Need for GUI Automation</div></div>',
    },
    {
      id: 'slide-02',
      content: '<div class="paper-title">AppAgent-Claw:<br>CLI Is All You Need for GUI Automation</div>',
    },
  ])
  const service = new DirectTextEditService()
  t.after(() => service.dispose())

  const started = await service.start(cwd, '.', presentationSelection(title), 'AppAgent-Claw')
  assert.equal(started.path, 'deck.json')
  const deck = JSON.parse(await readFile(join(cwd, 'deck.json'), 'utf8'))
  assert.match(deck.slides[0].content, /<div class="paper-title">AppAgent-Claw<\/div>/)
  assert.match(deck.slides[1].content, /AppAgent-Claw:<br>CLI Is All You Need/)

  const result = await service.verify(cwd, {
    transactionId: started.transactionId,
    verified: true,
    observedText: 'AppAgent-Claw',
  })
  assert.equal(result.status, 'committed')
})

test('presentation text edit falls back to a unique element in the selected slide', async (t) => {
  const cwd = await presentationFixture(t, [{
    id: 'slide-01',
    content: '<div><h2 class="section-title">项目背景<br>与研究目标</h2></div>',
  }])
  const service = new DirectTextEditService()
  t.after(() => service.dispose())

  await service.start(cwd, '.', presentationSelection('项目背景 与研究目标', {
    tagName: 'h2',
    attributes: { class: 'section-title' },
    presentationElementPath: undefined,
  }), '研究背景')
  const deck = JSON.parse(await readFile(join(cwd, 'deck.json'), 'utf8'))
  assert.match(deck.slides[0].content, /<h2 class="section-title">研究背景<\/h2>/)
})

test('presentation text edit preserves browser text semantics for inline markup', async (t) => {
  const cwd = await presentationFixture(t, [{
    id: 'slide-01',
    content: '<div class="layout-title"><div class="top-bar"></div><div class="paper-title">App<span>Agent</span>-Claw</div></div>',
  }])
  const service = new DirectTextEditService()
  t.after(() => service.dispose())

  await service.start(cwd, '.', presentationSelection('AppAgent-Claw'), 'PageCraft')
  const deck = JSON.parse(await readFile(join(cwd, 'deck.json'), 'utf8'))
  assert.match(deck.slides[0].content, /<div class="paper-title">PageCraft<\/div>/)
})

test('presentation text edit refuses ambiguous elements inside one slide', async (t) => {
  const cwd = await presentationFixture(t, [{
    id: 'slide-01',
    content: '<div><p class="label">重复文字</p><p class="label">重复文字</p></div>',
  }])
  const service = new DirectTextEditService()
  t.after(() => service.dispose())

  await assert.rejects(
    () => service.start(cwd, '.', presentationSelection('重复文字', {
      tagName: 'p',
      attributes: { class: 'label' },
      presentationElementPath: undefined,
    }), '新文字'),
    (error: any) => error.code === 'TEXT_SOURCE_AMBIGUOUS',
  )
})
