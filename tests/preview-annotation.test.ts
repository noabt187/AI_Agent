import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPreviewHtml } from '../src/server/preview.js'
import { listDirectories } from '../src/server/fileBrowser.js'
import { buildAnnotationPrompt, type ElementComment } from '../web/src/annotationPrompt.js'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('buildPreviewHtml injects the annotator script and base url', () => {
  const html = '<!doctype html><html><head><title>Demo</title></head><body><button>Save</button></body></html>'
  const result = buildPreviewHtml(html, 'http://localhost:3000/app/')

  assert.match(result, /<base href="http:\/\/localhost:3000\/app\/">/)
  assert.match(result, /window\.parent\.postMessage/)
  assert.match(result, /data-agent-annotator-active/)
  assert.match(result, /<button>Save<\/button>/)
})

test('buildAnnotationPrompt includes element context and user comments', () => {
  const comments: ElementComment[] = [
    {
      id: 'c1',
      url: 'http://localhost:3000',
      tagName: 'button',
      selector: 'main > button:nth-of-type(1)',
      domPath: 'html > body > main > button',
      text: '发送',
      comment: '这个按钮需要更醒目',
      rect: { x: 120, y: 300, width: 88, height: 40 },
    },
  ]

  const prompt = buildAnnotationPrompt(comments, '/tmp/demo')

  assert.match(prompt, /操作目录：\/tmp\/demo/)
  assert.match(prompt, /selector: main > button:nth-of-type\(1\)/)
  assert.match(prompt, /comment: 这个按钮需要更醒目/)
  assert.match(prompt, /完整修改功能闭环/)
  assert.match(prompt, /前端交互、状态管理、接口调用、后端接口\/数据逻辑/)
  assert.match(prompt, /判断需要修改哪些层/)
})

test('listDirectories returns only child directories with absolute paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-dir-'))
  await mkdir(join(root, 'app'))
  await mkdir(join(root, 'web'))
  await writeFile(join(root, 'README.md'), 'demo')

  const listing = await listDirectories(root)

  assert.equal(listing.path, root)
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['app', 'web'])
  assert.ok(listing.entries.every((entry) => entry.path.startsWith(root)))
})
