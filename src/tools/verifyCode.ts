import { readFileSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { CommandError, runCommand } from '../utils/command.js'
import { analyzeApiContracts } from './apiContracts.js'

// ── Types ──

interface Section {
  label: string
  lines: string[]
  hasError: boolean
}

// ── Helpers ──

/** 使用独立参数执行命令，保留启动失败与实际退出失败的区别。 */
async function runCmd(file: string, args: string[], cwd: string, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  signal?.throwIfAborted()
  try {
    const { stdout, stderr } = await runCommand(file, args, cwd, 120_000, signal)
    const raw = [stdout, stderr].filter(Boolean).join('\n')
    return { ok: true, output: raw.slice(0, 3000) }
  } catch (e: unknown) {
    if (signal?.aborted || (e instanceof CommandError && e.kind === 'aborted')) throw e
    const err = e as { stdout?: string; stderr?: string; message?: string }
    const raw = [err.stdout, err.stderr].filter(Boolean).join('\n')
    const kind = e instanceof CommandError ? ({ start: '命令未启动', exit: '命令执行失败', timeout: '命令超时', aborted: '已取消', 'output-limit': '输出超限' }[e.kind]) : '命令执行失败'
    return { ok: false, output: `${kind}: ${err.message ?? ''}\n${raw.slice(0, 3000)}` }
  }
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
  signal?: AbortSignal,
): Promise<Section> {
  const lines: string[] = []
  let hasError = false

  // tsc
  if (hasTS) {
    const { ok, output } = await runCmd('npx', ['--no-install', 'tsc', '--noEmit'], rootDir, signal)
    if (!ok) { hasError = true; lines.push(`❌ npx tsc --noEmit\n${extractErrors(output)}`) }
    else lines.push('✅ npx tsc --noEmit')
  } else {
    lines.push('ℹ️ npx tsc --noEmit  未检测到 TypeScript 项目，跳过')
  }

  // Root lint / build / test
  for (const [name, label] of [['lint', 'lint'], ['build', 'build'], ['test', 'test']] as const) {
    if (rootScripts[name]) {
      const args = name === 'test' ? ['test', '--', '--run'] : ['run', name]
      const { ok, output } = await runCmd('npm', args, rootDir, signal)
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
        const args = name === 'test' ? ['test', '--', '--run'] : ['run', name]
        const { ok, output } = await runCmd('npm', args, resolve(rootDir, dir), signal)
        if (!ok) { hasError = true; lines.push(`❌ ${dir}/npm run ${name}\n${extractErrors(output)}`) }
        else lines.push(`✅ ${dir}/npm run ${name}`)
      }
    }
  }

  return { label: '静态分析', lines, hasError }
}

async function runContractCheck(rootDir: string): Promise<Section> {
  const result = await analyzeApiContracts(rootDir)
  const lines = [`可解析调用匹配率：${result.coverage.percent === null ? '不可计算' : `${result.coverage.percent}%`}（${result.coverage.matchedCalls}/${result.coverage.totalCalls}）；另有 ${result.unresolved.length} 项未解析，不计入匹配率`]
  for (const { call, route } of result.matched) lines.push(`✅ ${call.method} ${call.path} (${call.file}:${call.line}) → ${route.path} (${route.file}:${route.line})`)
  for (const call of result.unmatchedCalls) lines.push(`⚠️ 调用未匹配 ${call.method} ${call.path} (${call.file}:${call.line})`)
  for (const route of result.unmatchedRoutes) lines.push(`⚠️ 路由未调用 ${route.method} ${route.path} (${route.file}:${route.line})`)
  for (const item of result.unresolved) lines.push(`⚠️ 未解析 ${item.kind} (${item.file}:${item.line})：${item.reason}；${item.evidence}`)
  if (result.calls.length === 0 && result.routes.length === 0 && result.unresolved.length === 0) lines.push('ℹ️ 未检测到可静态分析的 API 契约；此项未验证')
  return { label: 'API 契约（静态辅助检查，非集成测试）', lines, hasError: false }
}

// ── Format ──

function formatReport(sections: Section[]): string {
  const errorSections = sections.filter((s) => s.hasError)
  const warnSections = sections.filter((s) => s.lines.some((l) => l.startsWith('⚠️')))
  const ranExecutableCheck = sections.find((s) => s.label === '静态分析')?.lines.some((l) => l.startsWith('✅')) ?? false

  let header: string
  if (errorSections.length > 0) {
    header = '❌ 验证未通过'
  } else if (warnSections.length > 0) {
    const count = warnSections.reduce((sum, s) => sum + s.lines.filter((l) => l.startsWith('⚠️')).length, 0)
    header = `⚠️ 已完成可用检查，有 ${count} 项需关注`
  } else if (!ranExecutableCheck) {
    header = 'ℹ️ 未运行可用的编译、Lint、构建或测试命令；以下契约结果仅为静态辅助分析'
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

async function verifyCodeTool(rootDir: string, _changedFiles: string, signal?: AbortSignal): Promise<string> {
  const { rootScripts, subScripts, hasTS } = await detectEnvironment(rootDir)
  const sections: Section[] = []

  // Layer 1
  sections.push(await runStaticChecks(rootDir, rootScripts, subScripts, hasTS, signal))

  // Layer 2
  sections.push(await runContractCheck(rootDir))

  return formatReport(sections)
}

export { verifyCodeTool }
