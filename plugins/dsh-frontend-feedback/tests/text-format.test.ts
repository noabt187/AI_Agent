import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeSourceText, encodeSourceText } from '../src/client/text-format.ts'

test('homogeneous UTF-8 source text round trips without changing bytes', () => {
  for (const [raw, text, eol, bom] of [
    ['\uFEFF中文\r\n😀\r\n', '中文\n😀\n', 'crlf', true],
    ['a\nb\n', 'a\nb\n', 'lf', false],
    ['a\rb', 'a\nb', 'cr', false],
    ['', '', 'lf', false],
    ['\uFEFF', '', 'lf', true],
    ['中文😀', '中文😀', 'lf', false],
  ] as const) {
    const parsed = decodeSourceText(raw)
    assert.equal(parsed.text, text)
    assert.deepEqual(parsed.format, { eol, bom })
    assert.equal(encodeSourceText(parsed.text, parsed.format), raw)
  }
})

test('mixed endings are detected and cannot be silently serialized', () => {
  for (const raw of ['a\r\nb\nc', 'a\rb\nc', 'a\r\nb\rc']) {
    assert.equal(decodeSourceText(raw).format.eol, 'mixed')
    assert.throws(() => encodeSourceText('a\nb\nc', decodeSourceText(raw).format), /混合/)
  }
})
