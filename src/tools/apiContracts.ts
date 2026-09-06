import { readFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

export interface ContractEvidence {
  method: string
  path: string
  file: string
  line: number
  evidence: string
}

export interface UnresolvedContract {
  kind: 'call' | 'route' | 'mount'
  file: string
  line: number
  evidence: string
  reason: string
}

export interface ApiContractMatch { call: ContractEvidence; route: ContractEvidence }
export interface ApiContractAnalysis {
  matched: ApiContractMatch[]
  unmatchedCalls: ContractEvidence[]
  unmatchedRoutes: ContractEvidence[]
  unresolved: UnresolvedContract[]
  calls: ContractEvidence[]
  routes: ContractEvidence[]
  coverage: { matchedCalls: number; totalCalls: number; percent: number | null }
}

type Values = string[] | null
interface RawRoute extends ContractEvidence { receiver: string }
interface Mount { parent: string; child: string; paths: string[]; file: string; line: number; evidence: string }

const METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'state'])

function lineOf(sf: ts.SourceFile, node: ts.Node) { return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 }
function evidenceOf(sf: ts.SourceFile, node: ts.Node) { return node.getText(sf).replace(/\s+/g, ' ').slice(0, 240) }
function uniq(xs: string[]) { return [...new Set(xs)] }

function joinPath(a: string, b: string): string {
  if (/^https?:\/\//i.test(b)) { try { return new URL(b).pathname || '/' } catch {} }
  if (/^https?:\/\//i.test(a)) { try { a = new URL(a).pathname || '/' } catch {} }
  const left = a && a !== '/' ? `/${a.replace(/^\/+|\/+$/g, '')}` : ''
  const right = b && b !== '/' ? `/${b.replace(/^\/+|\/+$/g, '')}` : ''
  return `${left}${right}` || '/'
}

function normalized(path: string): string {
  let p = path
  try { if (/^https?:\/\//i.test(p)) p = new URL(p).pathname } catch {}
  p = p.split(/[?#]/, 1)[0]
  return (`/${p}`.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/')
    .replace(/:[A-Za-z_$][\w$]*/g, ':p')
    .replace(/\{[^/]+\}/g, ':p')
    .toLowerCase()
}

function isFallback(path: string) { return path === '*' || path === '/*' || path.includes('(.*)') || path.includes('*') }

async function sourceFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const { readdir } = await import('node:fs/promises')
  async function walk(dir: string) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) await walk(join(dir, e.name))
      else if (e.isFile() && ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extname(e.name)) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name)) out.push(join(dir, e.name))
    }
  }
  await walk(root)
  return out
}

function evaluate(node: ts.Expression | undefined, constants: Map<string, ts.Expression>, objects: Map<string, Map<string, ts.Expression>>, depth = 0): Values {
  if (!node || depth > 8) return null
  if (ts.isStringLiteralLike(node)) return [node.text]
  if (ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
  if (ts.isTemplateExpression(node)) {
    let values = [node.head.text]
    for (const span of node.templateSpans) {
      const part = evaluate(span.expression, constants, objects, depth + 1)
      const replacements = part ?? [':p']
      values = values.flatMap((v) => replacements.map((r) => v + r + span.literal.text))
    }
    return uniq(values)
  }
  if (ts.isIdentifier(node)) {
    const v = constants.get(node.text)
    return v ? evaluate(v, constants, objects, depth + 1) : null
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) return evaluate(node.expression, constants, objects, depth + 1)
  if (ts.isConditionalExpression(node)) {
    const a = evaluate(node.whenTrue, constants, objects, depth + 1)
    const b = evaluate(node.whenFalse, constants, objects, depth + 1)
    return a && b ? uniq([...a, ...b]) : null
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = evaluate(node.left, constants, objects, depth + 1), b = evaluate(node.right, constants, objects, depth + 1)
    return a && b ? uniq(a.flatMap(x => b.map(y => x + y))) : null
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const prop = objects.get(node.expression.text)?.get(node.name.text)
    return prop ? evaluate(prop, constants, objects, depth + 1) : null
  }
  return null
}

function objectProps(node: ts.Expression | undefined, objects: Map<string, Map<string, ts.Expression>>): Map<string, ts.Expression> | null {
  if (!node) return null
  if (ts.isIdentifier(node)) return objects.get(node.text) ?? null
  if (!ts.isObjectLiteralExpression(node)) return null
  const map = new Map<string, ts.Expression>()
  for (const p of node.properties) if (ts.isPropertyAssignment(p)) {
    const name = ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) ? p.name.text : null
    if (name) map.set(name, p.initializer)
  }
  return map
}

export async function analyzeApiContracts(rootDir: string): Promise<ApiContractAnalysis> {
  const calls: ContractEvidence[] = [], rawRoutes: RawRoute[] = [], unresolved: UnresolvedContract[] = [], mounts: Mount[] = []
  const rootReceivers = new Set<string>()
  const files = await sourceFiles(rootDir)
  const knownFiles = new Set(files.map(f => resolve(f)))
  const exportedReceiver = new Map<string, string>()
  for (const candidate of files) {
    const candidateText = await readFile(candidate, 'utf8')
    const candidateSf = ts.createSourceFile(candidate, candidateText, ts.ScriptTarget.Latest, true)
    candidateSf.forEachChild(function findExport(n) {
      if (ts.isExportAssignment(n) && ts.isIdentifier(n.expression)) exportedReceiver.set(resolve(candidate), n.expression.text)
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) &&
          ts.isIdentifier(n.left.expression) && n.left.expression.text === 'module' && n.left.name.text === 'exports' && ts.isIdentifier(n.right))
        exportedReceiver.set(resolve(candidate), n.right.text)
      ts.forEachChild(n, findExport)
    })
  }
  const moduleTarget = (from: string, spec: string) => {
    if (!spec.startsWith('.')) return null
    const base = resolve(dirname(from), spec)
    const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].map(x => base + x), ...['index.ts', 'index.tsx', 'index.js', 'index.jsx'].map(x => join(base, x))]
    return candidates.find(x => knownFiles.has(x)) ?? null
  }
  for (const full of files) {
    const text = await readFile(full, 'utf8')
    const file = relative(rootDir, full).replace(/\\/g, '/')
    const sf = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, /x$/.test(extname(full)) ? ts.ScriptKind.TSX : undefined)
    const constants = new Map<string, ts.Expression>(), objects = new Map<string, Map<string, ts.Expression>>()
    const ambiguousConstants = new Set<string>(), ambiguousObjects = new Set<string>()
    const axiosNames = new Set(['axios']), axiosInstances = new Map<string, Values>(), routerNames = new Set<string>(), appNames = new Set<string>(), importedRouters = new Map<string, string>(), unknownRouterImports = new Set<string>()
    const receiverId = (name: string) => importedRouters.get(name) ?? `${full}#${name}`

    sf.forEachChild(function collect(n) {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
        if (n.moduleSpecifier.text === 'axios' && n.importClause?.name) axiosNames.add(n.importClause.name.text)
        if (/^(express|express\/)/.test(n.moduleSpecifier.text) && n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings))
          for (const el of n.importClause.namedBindings.elements) if (el.propertyName?.text === 'Router' || el.name.text === 'Router') routerNames.add(el.name.text)
        const target = moduleTarget(full, n.moduleSpecifier.text)
        if (target && n.importClause?.name) {
          const exported = exportedReceiver.get(target)
          if (exported) importedRouters.set(n.importClause.name.text, `${target}#${exported}`)
          else unknownRouterImports.add(n.importClause.name.text)
        }
      }
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        if (constants.has(n.name.text)) { constants.delete(n.name.text); ambiguousConstants.add(n.name.text) }
        else if (!ambiguousConstants.has(n.name.text)) constants.set(n.name.text, n.initializer)
        const obj = objectProps(n.initializer, objects)
        if (obj) {
          if (objects.has(n.name.text)) { objects.delete(n.name.text); ambiguousObjects.add(n.name.text) }
          else if (!ambiguousObjects.has(n.name.text)) objects.set(n.name.text, obj)
        }
        if (ts.isCallExpression(n.initializer) && ts.isIdentifier(n.initializer.expression) && n.initializer.expression.text === 'require' && ts.isStringLiteral(n.initializer.arguments[0])) {
          const target = moduleTarget(full, n.initializer.arguments[0].text)
          if (target) {
            const exported = exportedReceiver.get(target)
            if (exported) importedRouters.set(n.name.text, `${target}#${exported}`)
            else unknownRouterImports.add(n.name.text)
          }
        }
      }
      ts.forEachChild(n, collect)
    })

    sf.forEachChild(function classify(n) {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer)) {
        const c = n.initializer.expression
        if (ts.isPropertyAccessExpression(c) && c.name.text === 'create' && ts.isIdentifier(c.expression) && axiosNames.has(c.expression.text)) {
          const props = objectProps(n.initializer.arguments[0], objects)
          const bases = props?.has('baseURL') ? evaluate(props.get('baseURL'), constants, objects) : ['']
          axiosInstances.set(n.name.text, bases)
        }
        if ((ts.isIdentifier(c) && routerNames.has(c.text)) || (ts.isPropertyAccessExpression(c) && c.name.text === 'Router')) routerNames.add(n.name.text)
        if (ts.isIdentifier(c) && (c.text === 'express' || c.text.endsWith('Express'))) { appNames.add(n.name.text); rootReceivers.add(receiverId(n.name.text)) }
      }
      if (ts.isCallExpression(n)) inspectCall(n)
      ts.forEachChild(n, classify)
    })

    function inspectCall(n: ts.CallExpression) {
      const ev = evidenceOf(sf, n), line = lineOf(sf, n)
      let receiver: string | null = null, method: string | null = null
      if (ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)) {
        receiver = n.expression.expression.text; method = n.expression.name.text.toLowerCase()
      }
      const isAxiosShortcut = !!receiver && (axiosNames.has(receiver) || axiosInstances.has(receiver)) && !!method && METHODS.has(method)
      const isAxiosConfig = ts.isIdentifier(n.expression) && (axiosNames.has(n.expression.text) || axiosInstances.has(n.expression.text))
      if (isAxiosShortcut || isAxiosConfig) {
        const props = isAxiosConfig ? objectProps(n.arguments[0], objects) : null
        const urlNode = isAxiosConfig ? props?.get('url') : n.arguments[0]
        const methodNode = isAxiosConfig && props?.has('method') ? props.get('method') : undefined
        const urls = evaluate(urlNode, constants, objects)
        const methods = isAxiosConfig ? (methodNode ? evaluate(methodNode, constants, objects) : ['GET']) : [method!.toUpperCase()]
        const instanceName = isAxiosConfig && ts.isIdentifier(n.expression) ? n.expression.text : receiver
        const bases = instanceName && axiosInstances.has(instanceName) ? axiosInstances.get(instanceName)! : ['']
        if (!urls || !methods || !bases) unresolved.push({ kind: 'call', file, line, evidence: ev, reason: !urls ? 'dynamic or unsupported URL' : !methods ? 'dynamic or unsupported method' : 'dynamic or unsupported axios baseURL' })
        else {
          let pairs: Array<[string, string]> | null = null
          if (urlNode && methodNode && ts.isConditionalExpression(urlNode) && ts.isConditionalExpression(methodNode) &&
              urlNode.condition.getText(sf) === methodNode.condition.getText(sf)) {
            const trueUrls = evaluate(urlNode.whenTrue, constants, objects), falseUrls = evaluate(urlNode.whenFalse, constants, objects)
            const trueMethods = evaluate(methodNode.whenTrue, constants, objects), falseMethods = evaluate(methodNode.whenFalse, constants, objects)
            if (trueUrls && falseUrls && trueMethods && falseMethods)
              pairs = [...trueUrls.flatMap(url => trueMethods.map(m => [url, m] as [string, string])), ...falseUrls.flatMap(url => falseMethods.map(m => [url, m] as [string, string]))]
            else unresolved.push({ kind: 'call', file, line, evidence: ev, reason: 'unsupported correlated axios method/URL branches' })
          } else if (urlNode && methodNode && ts.isConditionalExpression(urlNode) && ts.isConditionalExpression(methodNode)) {
            unresolved.push({ kind: 'call', file, line, evidence: ev, reason: 'method and URL conditions cannot be statically correlated' })
          } else pairs = urls.flatMap(url => methods.map(m => [url, m] as [string, string]))
          if (pairs) for (const base of bases) for (const [url, m] of pairs) calls.push({ method: m.toUpperCase(), path: joinPath(base, url), file, line, evidence: ev })
        }
        return
      }
      if (ts.isIdentifier(n.expression) && n.expression.text === 'fetch') {
        const urls = evaluate(n.arguments[0], constants, objects)
        const props = objectProps(n.arguments[1], objects)
        const methods = props?.has('method') ? evaluate(props.get('method'), constants, objects) : ['GET']
        if (!urls || !methods) unresolved.push({ kind: 'call', file, line, evidence: ev, reason: !urls ? 'dynamic or unsupported fetch URL' : 'dynamic or unsupported fetch method' })
        else for (const url of urls) for (const m of methods) calls.push({ method: m.toUpperCase(), path: joinPath('', url), file, line, evidence: ev })
        return
      }
      if (!receiver || !method) return
      if (method === 'use' && (routerNames.has(receiver) || appNames.has(receiver))) {
        const childArg = n.arguments[n.arguments.length - 1]
        const child = childArg && ts.isIdentifier(childArg) ? childArg.text : null
        const paths = n.arguments.length > 1 ? evaluate(n.arguments[0], constants, objects) : ['']
        if (child && unknownRouterImports.has(child)) unresolved.push({ kind: 'mount', file, line, evidence: ev, reason: `imported module for ${child} has no statically identified default Router export` })
        else if (child && paths) mounts.push({ parent: receiverId(receiver), child: receiverId(child), paths, file, line, evidence: ev })
        else if (child) unresolved.push({ kind: 'mount', file, line, evidence: ev, reason: 'dynamic or unsupported mount prefix' })
        return
      }
      if (METHODS.has(method) && (routerNames.has(receiver) || appNames.has(receiver))) {
        const paths = evaluate(n.arguments[0], constants, objects)
        if (!paths) unresolved.push({ kind: 'route', file, line, evidence: ev, reason: 'dynamic or unsupported route path' })
        else for (const path of paths) if (!isFallback(path)) rawRoutes.push({ receiver: receiverId(receiver), method: method.toUpperCase(), path, file, line, evidence: ev })
      }
    }
  }

  const prefixes = new Map<string, Set<string>>()
  for (const r of rawRoutes) if (!prefixes.has(r.receiver)) prefixes.set(r.receiver, new Set())
  for (const m of mounts) { if (!prefixes.has(m.parent)) prefixes.set(m.parent, new Set()); if (!prefixes.has(m.child)) prefixes.set(m.child, new Set()) }
  for (const name of rootReceivers) prefixes.get(name)?.add('')
  const byParent = new Map<string, Mount[]>()
  for (const m of mounts) byParent.set(m.parent, [...(byParent.get(m.parent) ?? []), m])
  const cycleEvidence = new Set<string>()
  function propagate(receiver: string, prefix: string, ancestors: Set<string>) {
    for (const m of byParent.get(receiver) ?? []) for (const p of m.paths) {
      if (ancestors.has(m.child)) {
        const key = `${m.file}:${m.line}`
        if (!cycleEvidence.has(key)) { cycleEvidence.add(key); unresolved.push({ kind: 'mount', file: m.file, line: m.line, evidence: m.evidence, reason: 'cyclic router mount was not expanded' }) }
        continue
      }
      const value = joinPath(prefix, p), set = prefixes.get(m.child) ?? new Set<string>(); prefixes.set(m.child, set)
      if (!set.has(value)) set.add(value)
      propagate(m.child, value, new Set([...ancestors, m.child]))
    }
  }
  for (const root of rootReceivers) propagate(root, '', new Set([root]))
  for (const r of rawRoutes) if ((prefixes.get(r.receiver)?.size ?? 0) === 0)
    unresolved.push({ kind: 'route', file: r.file, line: r.line, evidence: r.evidence, reason: `router ${r.receiver} is not statically mounted` })
  const routes = rawRoutes.flatMap(r => [...(prefixes.get(r.receiver) ?? [])].map(p => ({ ...r, path: joinPath(p, r.path) }))).map(({ receiver: _receiver, ...r }) => r)
  const matched: ApiContractMatch[] = [], unmatchedCalls: ContractEvidence[] = [], usedRoutes = new Set<number>()
  for (const call of calls) { const ri = routes.findIndex(r => r.method === call.method && normalized(r.path) === normalized(call.path)); if (ri < 0) unmatchedCalls.push(call); else { usedRoutes.add(ri); matched.push({ call, route: routes[ri] }) } }
  const unmatchedRoutes = routes.filter((_r, i) => !usedRoutes.has(i))
  return { matched, unmatchedCalls, unmatchedRoutes, unresolved, calls, routes, coverage: { matchedCalls: matched.length, totalCalls: calls.length, percent: calls.length ? Math.round(matched.length / calls.length * 100) : null } }
}
