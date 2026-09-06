import { applyEdits, findNodeAtLocation, modify, parseTree } from 'jsonc-parser'
import { parseFragment } from 'parse5'
import { SourceTextResolverError } from './source-text-resolver.ts'
import {
  readWorkspaceFile,
  WorkspaceExplorerError,
} from './workspace-explorer.ts'
import {
  normalizeWorkspacePath,
  type DomTextSelection,
  type WorkspaceFile,
} from './workspace.ts'

interface DeckSlide {
  id?: unknown
  content?: unknown
}

interface DeckDocument {
  slides?: unknown
}

interface HtmlSourceLocation {
  startOffset?: number
  endOffset?: number
  startTag?: { endOffset?: number }
  endTag?: { startOffset?: number }
}

interface HtmlNode {
  nodeName?: string
  tagName?: string
  value?: string
  attrs?: Array<{ name: string; value: string }>
  childNodes?: HtmlNode[]
  sourceCodeLocation?: HtmlSourceLocation
}

export interface PreparedPresentationTextEdit {
  file: WorkspaceFile
  line: number
  nextContent: string
}

const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
])

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function htmlText(node: HtmlNode): string {
  if (node.nodeName === '#text') return node.value ?? ''
  if (node.tagName?.toLowerCase() === 'br') return ' '
  return (node.childNodes ?? []).map(child => {
    const text = htmlText(child)
    return child.tagName !== undefined && BLOCK_ELEMENTS.has(child.tagName.toLowerCase()) ? ` ${text} ` : text
  }).join('')
}

function elementChildren(node: HtmlNode): HtmlNode[] {
  return (node.childNodes ?? []).filter(child => typeof child.tagName === 'string')
}

function attribute(node: HtmlNode, name: string): string | undefined {
  return node.attrs?.find(item => item.name.toLowerCase() === name.toLowerCase())?.value
}

function stableAttributesMatch(node: HtmlNode, selection: DomTextSelection): boolean {
  if (selection.textKey !== undefined && attribute(node, 'data-pagecraft-text-key') !== selection.textKey) return false
  for (const name of ['id', 'name', 'role', 'data-testid', 'data-pagecraft-text-key']) {
    const expected = selection.attributes[name]
    if (expected !== undefined && attribute(node, name) !== expected) return false
  }
  return true
}

function classMatchScore(node: HtmlNode, selection: DomTextSelection): number {
  const selected = new Set((selection.attributes.class ?? '').split(/\s+/).filter(Boolean))
  if (selected.size === 0) return 0
  const actual = new Set((attribute(node, 'class') ?? '').split(/\s+/).filter(Boolean))
  let score = 0
  for (const name of selected) {
    if (actual.has(name)) score += 1
  }
  return score
}

function matchesSelection(node: HtmlNode, selection: DomTextSelection): boolean {
  return node.tagName?.toLowerCase() === selection.tagName.toLowerCase()
    && normalizeText(htmlText(node)) === normalizeText(selection.displayedText)
    && stableAttributesMatch(node, selection)
}

function nodeAtElementPath(root: HtmlNode, path: number[]): HtmlNode | null {
  let current = root
  for (const index of path) {
    if (!Number.isSafeInteger(index) || index < 0) return null
    const child = elementChildren(current)[index]
    if (child === undefined) return null
    current = child
  }
  return current
}

function matchingElements(root: HtmlNode, selection: DomTextSelection): HtmlNode[] {
  const matches: HtmlNode[] = []
  function visit(node: HtmlNode): void {
    if (matchesSelection(node, selection)) matches.push(node)
    for (const child of elementChildren(node)) visit(child)
  }
  visit(root)
  return matches
}

function chooseElement(root: HtmlNode, selection: DomTextSelection): HtmlNode {
  const path = selection.presentationElementPath
  if (path !== undefined) {
    const exact = nodeAtElementPath(root, path)
    if (exact !== null && matchesSelection(exact, selection)) return exact
  }

  const matches = matchingElements(root, selection)
  if (matches.length === 0) {
    throw new SourceTextResolverError(
      '当前幻灯片中没有找到与所选文字对应的 HTML 元素，PageCraft 没有修改文件',
      'TEXT_SOURCE_NOT_FOUND',
      404,
    )
  }
  if (matches.length === 1) return matches[0]

  const ranked = matches
    .map(node => ({ node, score: classMatchScore(node, selection) }))
    .sort((left, right) => right.score - left.score)
  const [first, second] = ranked
  if (first !== undefined && first.score > (second?.score ?? -1)) return first.node
  throw new SourceTextResolverError(
    '当前幻灯片中有多个元素显示相同文字，PageCraft 没有猜测或修改文件',
    'TEXT_SOURCE_AMBIGUOUS',
  )
}

function escapeHtmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function replaceElementText(source: string, node: HtmlNode, replacementText: string): string {
  const start = node.sourceCodeLocation?.startTag?.endOffset
  const end = node.sourceCodeLocation?.endTag?.startOffset
  if (start === undefined || end === undefined || start > end) {
    throw new SourceTextResolverError(
      '所选文字节点没有稳定的源码范围，PageCraft 没有修改文件',
      'TEXT_SOURCE_NOT_FOUND',
      404,
    )
  }
  return `${source.slice(0, start)}${escapeHtmlText(replacementText)}${source.slice(end)}`
}

function deckPath(selectedFolder: string): string | null {
  const folder = normalizeWorkspacePath(selectedFolder)
  if (folder === null) return null
  return folder === '.' ? 'deck.json' : `${folder}/deck.json`
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length
}

function contentLine(source: string, slideIndex: number): number {
  const root = parseTree(source)
  const node = root === undefined ? undefined : findNodeAtLocation(root, ['slides', slideIndex, 'content'])
  return lineAt(source, node?.offset ?? 0)
}

function parseDeck(source: string): DeckDocument {
  try {
    const value = JSON.parse(source) as unknown
    if (value === null || typeof value !== 'object') throw new Error('Deck must be an object')
    return value as DeckDocument
  } catch (error) {
    throw new SourceTextResolverError(
      'deck.json 不是有效的 JSON，PageCraft 没有修改文件',
      'TEXT_SOURCE_NOT_FOUND',
      409,
      { cause: error instanceof Error ? error.message : String(error) },
    )
  }
}

async function readDeck(
  cwd: string,
  selectedFolder: string,
): Promise<{ file: WorkspaceFile; path: string } | null> {
  const path = deckPath(selectedFolder)
  if (path === null) return null
  try {
    return { file: await readWorkspaceFile(cwd, selectedFolder, path), path }
  } catch (error) {
    if (error instanceof WorkspaceExplorerError && error.code === 'WORKSPACE_ENTRY_NOT_FOUND') return null
    throw error
  }
}

export async function preparePresentationTextEdit(
  cwd: string,
  selectedFolder: string,
  selection: DomTextSelection,
  replacementText: string,
): Promise<PreparedPresentationTextEdit | null> {
  if (selection.slideId === undefined) return null
  const stored = await readDeck(cwd, selectedFolder)
  if (stored === null) return null

  const deck = parseDeck(stored.file.content)
  if (!Array.isArray(deck.slides)) {
    throw new SourceTextResolverError('deck.json 没有有效的幻灯片列表', 'TEXT_SOURCE_NOT_FOUND', 404)
  }
  const slideIndexes = deck.slides.flatMap((slide, index) => {
    if (slide !== null && typeof slide === 'object' && (slide as DeckSlide).id === selection.slideId) return [index]
    return []
  })
  if (slideIndexes.length !== 1) {
    throw new SourceTextResolverError(
      slideIndexes.length === 0 ? 'deck.json 中没有找到当前幻灯片' : 'deck.json 中存在重复的幻灯片 ID',
      slideIndexes.length === 0 ? 'TEXT_SOURCE_NOT_FOUND' : 'TEXT_SOURCE_AMBIGUOUS',
      409,
    )
  }

  const slideIndex = slideIndexes[0]
  const slide = deck.slides[slideIndex] as DeckSlide
  if (typeof slide.content !== 'string') {
    throw new SourceTextResolverError('当前幻灯片没有可编辑的 HTML 内容', 'TEXT_SOURCE_NOT_FOUND', 404)
  }
  const fragment = parseFragment(slide.content, { sourceCodeLocationInfo: true }) as unknown as HtmlNode
  const target = chooseElement(fragment, selection)
  const nextSlideContent = replaceElementText(slide.content, target, replacementText)
  const edits = modify(
    stored.file.content,
    ['slides', slideIndex, 'content'],
    nextSlideContent,
    {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol: stored.file.content.includes('\r\n') ? '\r\n' : '\n',
      },
    },
  )
  return {
    file: stored.file,
    line: contentLine(stored.file.content, slideIndex),
    nextContent: applyEdits(stored.file.content, edits),
  }
}
