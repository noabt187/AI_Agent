import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listDirectories } from '../src/server/fileBrowser.js'

test('directory errors are actionable and trimmed valid paths recover', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-directories-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }))
  await mkdir(join(dir, 'child'))
  await writeFile(join(dir, 'file.txt'), 'text')
  await assert.rejects(listDirectories('relative/path'), /绝对路径/)
  await assert.rejects(listDirectories(join(dir, 'missing')), /文件夹不存在/)
  await assert.rejects(listDirectories(join(dir, 'file.txt')), /该路径是文件/)
  const result = await listDirectories(`  ${dir}  `)
  assert.equal(result.path, dir)
  assert.deepEqual(result.entries.map(item => item.name), ['child'])
  assert.ok((await listDirectories(undefined, {roots:true})).path)
})
