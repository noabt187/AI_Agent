export interface TextFormat {
  eol: 'lf' | 'crlf' | 'cr' | 'mixed'
  bom: boolean
}

export function decodeSourceText(raw: string): { text: string; format: TextFormat } {
  const bom = raw.startsWith('\uFEFF')
  const body = bom ? raw.slice(1) : raw
  const endings = new Set(body.match(/\r\n|\r|\n/g) ?? [])
  const eol = endings.size > 1 ? 'mixed' : endings.has('\r\n') ? 'crlf' : endings.has('\r') ? 'cr' : 'lf'
  return { text: body.replace(/\r\n|\r/g, '\n'), format: { eol, bom } }
}

export function encodeSourceText(text: string, format: TextFormat): string {
  if (format.eol === 'mixed') throw new Error('不自动统一混合换行；此文件只读。')
  const eol = format.eol === 'crlf' ? '\r\n' : format.eol === 'cr' ? '\r' : '\n'
  return (format.bom ? '\uFEFF' : '') + text.replace(/\r\n|\r|\n/g, eol)
}
