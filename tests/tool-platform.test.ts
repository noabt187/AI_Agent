import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { executeTool } from '../src/tools/index.js'
import { commandInvocationForPlatform, resolveCommandForPlatform } from '../src/utils/command.js'

test('source search includes mjs files by basename and content', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-search-mjs-'))
  await mkdir(resolve(rootDir, 'src'), { recursive: true })
  await writeFile(resolve(rootDir, 'src', 'slug.mjs'), 'export function slugify(value) { return value }\n', 'utf8')

  const byName = await executeTool('searchFiles', { rootDir, pattern: '*slug*' }, [rootDir])
  const byContent = await executeTool('searchContent', { rootDir, keyword: 'slugify' }, [rootDir])
  assert.match(byName, /src\/slug\.mjs/)
  assert.match(byContent, /src\/slug\.mjs:1/)
})

test('node package manager commands resolve to cmd shims only on Windows', () => {
  assert.equal(resolveCommandForPlatform('npm', 'win32'), 'npm.cmd')
  assert.equal(resolveCommandForPlatform('npx', 'win32'), 'npx.cmd')
  assert.equal(resolveCommandForPlatform('git', 'win32'), 'git')
  assert.equal(resolveCommandForPlatform('npm', 'linux'), 'npm')

  assert.deepEqual(commandInvocationForPlatform('npm', ['test', '--', '--run'], 'win32', 'cmd.exe'), {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', 'npm.cmd test -- --run'],
  })
  assert.deepEqual(commandInvocationForPlatform('git', ['status'], 'win32', 'cmd.exe'), {
    file: 'git',
    args: ['status'],
  })
})
