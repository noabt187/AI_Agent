import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { analyzeApiContracts } from '../src/tools/apiContracts.js'

async function fixture(t: TestContext, files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'api-contracts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true })
    await writeFile(join(root, name), content)
  }
  return root
}

test('matches axios shortcuts, config calls, instances, templates, conditional methods and mounted routers', async (t) => {
  const root = await fixture(t, {
    'client/api.ts': `
      import request from 'axios'
      const api = request.create({ baseURL: '/api' })
      const id = getId()
      api.get(\`/articles/\${id}\`)
      request({ url: '/api/users/login', method: loggedIn ? 'POST' : 'PUT' })
      request.delete('/api/articles/missing')
    `,
    'server/router.ts': `
      import express, { Router as MakeRouter } from 'express'
      const app = express()
      const api = MakeRouter()
      const articles = MakeRouter()
      articles.get('/:slug', handler)
      api.use('/articles', articles)
      api.post('/users/login', handler)
      api.put('/users/login', handler)
      api.get('*', fallback)
      app.use('/api', api)
    `,
  })
  const result = await analyzeApiContracts(root)
  assert.equal(result.matched.length, 3)
  assert.equal(result.unmatchedCalls.length, 1)
  assert.equal(result.unmatchedCalls[0].path, '/api/articles/missing')
  assert.equal(result.unmatchedRoutes.length, 0)
  assert.equal(result.coverage.percent, 75)
  assert.ok(result.matched.every(x => x.call.line > 0 && x.call.evidence.length > 0))
  assert.ok(!result.routes.some(x => x.path.includes('*')), 'static fallback routes are excluded')
})

test('keeps dynamic calls, routes and mount prefixes unresolved instead of treating analysis as clean', async (t) => {
  const root = await fixture(t, {
    'client.js': `import axios from 'axios'; axios.get(makeUrl())`,
    'server.js': `import express from 'express'; const app=express(); const r=express.Router(); r.get(routeName, h); app.use(prefix(), r)`,
  })
  const result = await analyzeApiContracts(root)
  assert.equal(result.matched.length, 0)
  assert.ok(result.unresolved.some(x => x.kind === 'call' && /URL/.test(x.reason)))
  assert.ok(result.unresolved.some(x => x.kind === 'route'))
  assert.ok(result.unresolved.some(x => x.kind === 'mount'))
  assert.ok(result.unresolved.every(x => x.file && x.line > 0 && x.evidence))
})

test('distinguishes method mismatch from an unresolved expression', async (t) => {
  const root = await fixture(t, {
    'client.ts': `import axios from 'axios'; axios.post('/api/health')`,
    'server.ts': `import express from 'express'; const app=express(); app.get('/api/health', h)`,
  })
  const result = await analyzeApiContracts(root)
  assert.equal(result.unmatchedCalls.length, 1)
  assert.equal(result.unmatchedRoutes.length, 1)
  assert.equal(result.unresolved.length, 0)
})

test('handles cyclic mounts without unbounded path expansion', async (t) => {
  const root = await fixture(t, {
    'server.ts': `import express from 'express'; const app=express(); const a=express.Router(); const b=express.Router(); a.get('/ok', h); app.use('/api', a); a.use('/b', b); b.use('/a', a)`,
    'client.ts': `import axios from 'axios'; axios.get('/api/ok')`,
  })
  const result = await analyzeApiContracts(root)
  assert.equal(result.matched.length, 1)
  assert.ok(result.unresolved.some(x => /cyclic router mount/.test(x.reason)))
})

test('keeps fetch calls and applies GET defaults for fetch and axios config', async (t) => {
  const root = await fixture(t, {
    'server.ts': `import express from 'express'; const app=express(); app.get('/api/a', h); app.post('/api/b', h); app.get('/api/c', h)`,
    'client.ts': `import axios from 'axios'; fetch('/api/a'); fetch('/api/b', {method: 'POST'}); axios({url: '/api/c'})`,
  })
  const result = await analyzeApiContracts(root)
  assert.equal(result.matched.length, 3)
  assert.deepEqual(result.calls.map(x => x.method).sort(), ['GET', 'GET', 'POST'])
})

test('supports callable instances, normalizes absolute bases, and does not guess dynamic baseURL', async (t) => {
  const root = await fixture(t, {
    'server.ts': `import express from 'express'; const app=express(); app.get('/api/items', h)`,
    'client.ts': `import axios from 'axios'; const api=axios.create({baseURL:'https://example.test/api'}); api({url:'items'}); const unknown=axios.create({baseURL:getBase()}); unknown.get('/items')`,
  })
  const result = await analyzeApiContracts(root)
  assert.equal(result.matched.length, 1)
  assert.equal(result.matched[0].call.path, '/api/items')
  assert.ok(result.unresolved.some(x => /baseURL/.test(x.reason)))
})

test('treats repeated identifiers in different scopes as ambiguous, not a false match', async (t) => {
  const root = await fixture(t, {
    'server.ts': `import express from 'express'; const app=express(); app.get('/api/right', h)`,
    'client.ts': `import axios from 'axios'; function one(){ const url='/api/right'; return axios.get(url) } function two(){ const url='/api/wrong'; return axios.get(url) }`,
  })
  const result = await analyzeApiContracts(root)
  assert.equal(result.matched.length, 0)
  assert.equal(result.unresolved.filter(x => x.kind === 'call').length, 2)
})

test('resolves common default and CommonJS Router exports whose variable is not named router', async (t) => {
  const root = await fixture(t, {
    'server.ts': `import express from 'express'; import users from './users'; const articles=require('./articles'); const app=express(); app.use('/api/users', users); app.use('/api/articles', articles)`,
    'users.ts': `import express from 'express'; const api=express.Router(); api.post('/login', h); export default api`,
    'articles.js': `const express=require('express'); const endpoints=express.Router(); endpoints.post('/:slug/favorite', h); module.exports=endpoints`,
    'client.ts': `import axios from 'axios'; const slug=getSlug(); axios.post('/api/users/login'); axios.post(\`/api/articles/\${slug}/favorite\`)`,
  })
  const result = await analyzeApiContracts(root)
  assert.equal(result.matched.length, 2)
  assert.equal(result.unresolved.length, 0)
})

test('pairs same-condition Axios method and URL branches and ignores query/hash when matching routes', async (t) => {
  const root = await fixture(t, {
    'server.ts': `import express from 'express'; const app=express(); app.put('/api/articles/:slug', h); app.post('/api/articles', h); app.get('/api/articles', h)`,
    'client.ts': `import axios from 'axios'; const slug=getSlug(); axios({method:slug?'PUT':'POST', url:slug?\`/api/articles/\${slug}\`:'/api/articles'}); axios.get('/api/articles?limit=10#top')`,
  })
  const result = await analyzeApiContracts(root)
  assert.equal(result.matched.length, 3)
  assert.equal(result.unmatchedCalls.length, 0)
  assert.ok(!result.calls.some(x => x.method === 'POST' && x.path.includes(':p')))
  assert.ok(!result.calls.some(x => x.method === 'PUT' && x.path === '/api/articles'))
})
