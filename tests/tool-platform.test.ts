import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { executeToolResult } from '../src/tools/index.js'
import { commandInvocationForPlatform, resolveCommandForPlatform } from '../src/utils/command.js'

test('source search includes mjs files by basename and content', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-search-mjs-'))
  await mkdir(resolve(rootDir, 'src'), { recursive: true })
  await writeFile(resolve(rootDir, 'src', 'slug.mjs'), 'export function slugify(value) { return value }\n', 'utf8')

  const byName = await executeToolResult('searchFiles', { rootDir, pattern: '*slug*' }, [rootDir])
  const byContent = await executeToolResult('searchContent', { rootDir, keyword: 'slugify' }, [rootDir])
  assert.match(byName.message, /src\/slug\.mjs/)
  assert.match(byContent.message, /src\/slug\.mjs:1/)
})

test('node package managers resolve on Windows without shell interpolation', async t => {
  assert.equal(resolveCommandForPlatform('npm', 'win32'), 'npm.cmd')
  assert.equal(resolveCommandForPlatform('npx', 'win32'), 'npx.cmd')
  assert.equal(resolveCommandForPlatform('git', 'win32'), 'git')
  assert.equal(resolveCommandForPlatform('npm', 'linux'), 'npm')

  assert.deepEqual(commandInvocationForPlatform('git', ['status'], 'win32'), {
    file: 'git',
    args: ['status'],
  })
  const root = await mkdtemp(join(tmpdir(), 'package manager space '))
  t.after(() => rm(root, { recursive: true, force: true }))
  const entries = { npm: 'npm/bin/npm-cli.js', npx: 'npm/bin/npx-cli.js', pnpm: 'pnpm/bin/pnpm.cjs', yarn: 'corepack/dist/yarn.js' }
  const args = ['test', '--', 'space & echo injected | %PATH% !VALUE!', 'quote"and^caret']
  for (const [name, entry] of Object.entries(entries)) {
    const cli = join(root, 'node_modules', entry)
    await mkdir(resolve(cli, '..'), { recursive: true })
    await writeFile(cli, '// fixture')
    for (const command of [name, name + '.cmd', name + '.ps1']) {
      assert.deepEqual(commandInvocationForPlatform(command, args, 'win32', [root]), {
        file: process.execPath, args: [cli, ...args],
      })
    }
    assert.deepEqual(commandInvocationForPlatform(name, args, 'linux', [root]), { file: name, args })
  }
  assert.throws(() => commandInvocationForPlatform('npm', [], 'win32', []), /无法定位 npm CLI/)
})
