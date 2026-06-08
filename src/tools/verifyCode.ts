import { readFile, access } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { exec } from 'node:child_process'

// ── Types ──

interface Section {
  label: string
  lines: string[]
  hasError: boolean
}

// ── Helpers ──

function runCmd(cmd: string, cwd: string, timeout = 120_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((r) => {
    exec(cmd, { cwd, timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const raw = [stdout, stderr].filter(Boolean).join('\n')
      r({ ok: !err, output: raw.slice(0, 3000) })
    })
  })
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p) } catch { return false }
  return true
}

function readFileSafe(p: string): string | null {
  try { return readFileSync(p, 'utf8') } catch { return null }
}

function extractErrors(output: string): string {
  const lines = output.split('\n')
  const relevant = lines.filter((l) =>
    /error|fail/i.test(l) || /\.[jt]sx?[(:]/.test(l),
  )
  return relevant.length > 0 ? relevant.slice(0, 10).join('\n') : output.slice(0, 600)
}

function isApiPath(p: string): boolean {
  return p.startsWith('/') || /\/api\//i.test(p)
}

// ── Path normalization for contract matching ──

function normalizePath(p: string): string {
  return p
    .replace(/:(\w+)/g, ':p')        // Express :param
    .replace(/\$\{(\w+)\}/g, ':p')   // template literal ${param}
    .replace(/\/$/, '')              // trailing slash
    .toLowerCase()
}

// ── Detection ──

async function detectEnvironment(rootDir: string): Promise<{
  rootScripts: Record<string, string>
  subScripts: Record<string, Record<string, string>>
  hasTS: boolean
}> {
  const rootScripts: Record<string, string> = {}
  const subScripts: Record<string, Record<string, string>> = {}
  let hasTS = false

  // Root package.json
  const rootPkg = readFileSafe(resolve(rootDir, 'package.json'))
  if (rootPkg) {
    try {
      const p = JSON.parse(rootPkg)
      Object.assign(rootScripts, p.scripts || {})
      if (p.devDependencies?.typescript || p.dependencies?.typescript) hasTS = true
    } catch {}
  }

  if (!hasTS && await fileExists(resolve(rootDir, 'tsconfig.json'))) {
    hasTS = true
  }

  // Subdirectories
  for (const sub of ['backend', 'frontend', 'server', 'client']) {
    const subPkg = readFileSafe(resolve(rootDir, sub, 'package.json'))
    if (!subPkg) continue
    try {
      const p = JSON.parse(subPkg)
      subScripts[sub] = p.scripts || {}
    } catch {}
  }

  return { rootScripts, subScripts, hasTS }
}

// ── Layer 1: Static Analysis ──

async function runStaticChecks(
  rootDir: string,
  rootScripts: Record<string, string>,
  subScripts: Record<string, Record<string, string>>,
  hasTS: boolean,
): Promise<Section> {
  const lines: string[] = []
  let hasError = false

  // tsc
  if (hasTS) {
    const { ok, output } = await runCmd('npx tsc --noEmit', rootDir)
    if (!ok) { hasError = true; lines.push(`❌ npx tsc --noEmit\n${extractErrors(output)}`) }
    else lines.push('✅ npx tsc --noEmit')
  } else {
    lines.push('ℹ️ npx tsc --noEmit  未检测到 TypeScript 项目，跳过')
  }

  // Root lint / build / test
  for (const [name, label] of [['lint', 'lint'], ['build', 'build'], ['test', 'test']] as const) {
    if (rootScripts[name]) {
      const cmd = name === 'test' ? 'npm test -- --run' : `npm run ${name}`
      const { ok, output } = await runCmd(cmd, rootDir)
      if (!ok) { hasError = true; lines.push(`❌ npm run ${label}\n${extractErrors(output)}`) }
      else lines.push(`✅ npm run ${label}`)
    } else {
      lines.push(`ℹ️ npm run ${label}  未配置，跳过`)
    }
  }

  // Sub-project checks
  for (const [dir, sc] of Object.entries(subScripts)) {
    for (const name of ['lint', 'test', 'build']) {
      if (sc[name]) {
        const cmd = name === 'test' ? 'npm test' : `npm run ${name}`
        const { ok, output } = await runCmd(cmd, resolve(rootDir, dir))
        if (!ok) { hasError = true; lines.push(`❌ ${dir}/npm run ${name}\n${extractErrors(output)}`) }
        else lines.push(`✅ ${dir}/npm run ${name}`)
      }
    }
  }

  return { label: '静态分析', lines, hasError }
}

// ── Layer 2: API Contract Check ──

interface Route {
  method: string
  path: string
  file: string
  line: number
}

function extractRoutes(files: string[], rootDir: string): Route[] {
  const routes: Route[] = []
  // Match Express-style: .get('/path'), .post('/path'), etc.
  // Only match paths starting with '/'
  const re = /\.\s*(get|post|put|delete|patch)\s*\(\s*['"`](\/[^'"`]*)['"`]/gi

  for (const file of files) {
    if (!/backend|server|api|routes?|controllers?|router/i.test(file)) continue
    if (/node_modules|dist|\.test\.|\.spec\.|__tests__/i.test(file)) continue
    const content = readFileSafe(resolve(rootDir, file))
    if (!content) continue

    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
      routes.push({
        method: m[1].toUpperCase(),
        path: m[2],
        file,
        line: content.slice(0, m.index).split('\n').length,
      })
    }
  }
  return routes
}

function extractApiCalls(files: string[], rootDir: string): Route[] {
  const calls: Route[] = []

  // fetch() calls — path must start with '/' or contain '/api/'
  const fetchRe = /fetch\s*\(\s*['"`]([^'"`]*)['"`]/g
  // axios calls
  const axiosRe = /axios\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]*)['"`]/gi

  for (const file of files) {
    if (!/frontend|client|src|pages?|components?|services?|api/i.test(file)) continue
    if (/node_modules|dist|\.test\.|\.spec\.|__tests__/i.test(file)) continue
    if (/src\/tools\/verifyCode/i.test(file)) continue
    const content = readFileSafe(resolve(rootDir, file))
    if (!content) continue

    // fetch
    let fm: RegExpExecArray | null
    while ((fm = fetchRe.exec(content)) !== null) {
      const url = fm[1]
      if (!isApiPath(url)) continue
      const after = content.slice(fm.index + fm[0].length, fm.index + fm[0].length + 200)
      const methodMatch = after.match(/method\s*:\s*['"`](\w+)['"`]/i)
      calls.push({
        method: (methodMatch?.[1] || 'GET').toUpperCase(),
        path: url,
        file,
        line: content.slice(0, fm.index).split('\n').length,
      })
    }

    // axios
    let am: RegExpExecArray | null
    while ((am = axiosRe.exec(content)) !== null) {
      if (!isApiPath(am[2])) continue
      calls.push({
        method: am[1].toUpperCase(),
        path: am[2],
        file,
        line: content.slice(0, am.index).split('\n').length,
      })
    }
  }
  return calls
}

async function collectSourceFiles(rootDir: string): Promise<string[]> {
  const exts = ['.ts', '.tsx', '.js', '.jsx']
  const skip = new Set(['node_modules', '.git', 'dist', 'state', 'build', '.next'])
  const results: string[] = []
  async function walk(base: string, prefix: string) {
    const { readdir, stat } = await import('node:fs/promises')
    let entries: string[]
    try { entries = await readdir(join(base, prefix)) } catch { return }
    for (const entry of entries) {
      if (skip.has(entry)) continue
      const rel = prefix ? `${prefix}/${entry}` : entry
      const full = join(base, rel)
      let s: Awaited<ReturnType<typeof stat>>
      try { s = await stat(full) } catch { continue }
      if (s.isDirectory()) { await walk(base, rel) }
      else if (exts.some((e) => entry.endsWith(e))) { results.push(rel) }
    }
  }
  await walk(rootDir, '')
  return results
}

async function runContractCheck(rootDir: string): Promise<Section> {
  const lines: string[] = []

  const allFiles = await collectSourceFiles(rootDir)
  const routes = extractRoutes(allFiles, rootDir)
  const calls = extractApiCalls(allFiles, rootDir)

  if (routes.length === 0 && calls.length === 0) {
    lines.push('ℹ️ 未检测到后端路由或前端 API 调用，跳过契约检查')
    return { label: 'API 契约', lines, hasError: false }
  }

  if (routes.length === 0) {
    lines.push('ℹ️ 未检测到后端路由定义，跳过契约检查')
    return { label: 'API 契约', lines, hasError: false }
  }

  const matchedRoutes = new Set<number>()
  const matchedCalls = new Set<number>()
  const pairs: string[] = []

  for (let ri = 0; ri < routes.length; ri++) {
    for (let fi = 0; fi < calls.length; fi++) {
      if (routes[ri].method === calls[fi].method &&
          normalizePath(routes[ri].path) === normalizePath(calls[fi].path)) {
        matchedRoutes.add(ri)
        matchedCalls.add(fi)
        pairs.push(`✅ ${routes[ri].method.padEnd(7)} ${routes[ri].path}`)
        pairs.push(`        → ${calls[fi].method.padEnd(7)} ${calls[fi].path} (${calls[fi].file}:${calls[fi].line})`)
        break
      }
    }
  }

  if (pairs.length > 0) { lines.push(...pairs); lines.push('') }

  let hasWarning = false

  for (let ri = 0; ri < routes.length; ri++) {
    if (!matchedRoutes.has(ri)) {
      hasWarning = true
      const r = routes[ri]
      lines.push(`⚠️ ${r.method.padEnd(7)} ${r.path} (${r.file}:${r.line})`)
      lines.push('          ← 前端未找到对应调用')
    }
  }

  for (let fi = 0; fi < calls.length; fi++) {
    if (!matchedCalls.has(fi)) {
      hasWarning = true
      const c = calls[fi]
      lines.push(`⚠️ ${c.method.padEnd(7)} ${c.path} (${c.file}:${c.line})`)
      lines.push('          ← 后端未找到对应路由')
    }
  }

  if (!hasWarning && pairs.length === 0) {
    lines.push('ℹ️ 未发现可匹配的 API 契约')
  }

  return { label: 'API 契约', lines, hasError: false }
}

// ── Format ──

function formatReport(sections: Section[]): string {
  const errorSections = sections.filter((s) => s.hasError)
  const warnSections = sections.filter((s) => s.lines.some((l) => l.startsWith('⚠️')))

  let header: string
  if (errorSections.length > 0) {
    header = '❌ 验证未通过'
  } else if (warnSections.length > 0) {
    const count = warnSections.reduce((sum, s) => sum + s.lines.filter((l) => l.startsWith('⚠️')).length, 0)
    header = `⚠️ 验证通过，契约检查有 ${count} 项需关注`
  } else {
    header = '✅ 验证通过'
  }

  const parts = [header]

  for (const section of sections) {
    parts.push('')
    parts.push(`## ${section.label}`)
    parts.push(...section.lines)
  }

  return parts.join('\n')
}

// ── Main ──

async function verifyCodeTool(rootDir: string, _changedFiles: string): Promise<string> {
  const { rootScripts, subScripts, hasTS } = await detectEnvironment(rootDir)
  const sections: Section[] = []

  // Layer 1
  sections.push(await runStaticChecks(rootDir, rootScripts, subScripts, hasTS))

  // Layer 2
  sections.push(await runContractCheck(rootDir))

  return formatReport(sections)
}

export { verifyCodeTool }
