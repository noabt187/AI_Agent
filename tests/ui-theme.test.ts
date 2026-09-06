import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { readThemeMode, saveThemeMode, themeStorageKey } from '../web/src/theme.js'

test('ink workspace defaults to light, including absent or invalid preferences', () => {
  assert.equal(readThemeMode(), 'light')
  assert.equal(readThemeMode({ getItem: () => null }), 'light')
  assert.equal(readThemeMode({ getItem: () => 'unknown' }), 'light')
})

test('explicit light and dark preferences are preserved', () => {
  assert.equal(readThemeMode({ getItem: () => 'dark' }), 'dark')
  assert.equal(readThemeMode({ getItem: () => 'light' }), 'light')
  const writes: Array<[string, string]> = []
  saveThemeMode('light', { setItem: (key, value) => { writes.push([key, value]) } })
  assert.deepEqual(writes, [[themeStorageKey, 'light']])
})

test('unavailable browser storage does not prevent rendering or toggling theme', () => {
  assert.equal(readThemeMode({ getItem: () => { throw new Error('Storage blocked') } }), 'light')
  assert.doesNotThrow(() => saveThemeMode('dark', { setItem: () => { throw new Error('Storage blocked') } }))
})

test('the default workspace palette stays grayscale with readable secondary text', async () => {
  const css = await readFile(new URL('../web/src/styles.css', import.meta.url), 'utf8')
  const lightPalette = css.match(/\.appShell\s*\{([^}]+)\}/)?.[1]
  assert.ok(lightPalette)
  function token(name: string): string {
    const value = lightPalette!.match(new RegExp(`--${name}:\\s*(#[a-f0-9]{6})`, 'i'))?.[1]
    assert.ok(value, `missing ${name} token`)
    return value
  }
  for (const name of ['canvas', 'sidebar', 'surface', 'text', 'muted', 'subtle']) {
    const color = token(name)
    assert.equal(color.slice(1, 3), color.slice(3, 5), `${name} must not gain a yellow or blue tint`)
    assert.equal(color.slice(3, 5), color.slice(5, 7))
  }
  function luminance(hex: string): number {
    const component = parseInt(hex.slice(1, 3), 16) / 255
    return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4
  }
  for (const surface of ['canvas', 'sidebar']) {
    for (const label of ['text', 'muted', 'subtle']) {
      const contrast = (luminance(token(surface)) + 0.05) / (luminance(token(label)) + 0.05)
      assert.ok(contrast >= 4.5, `${label} on ${surface}: ${contrast.toFixed(2)} contrast`)
    }
  }
  assert.match(css, /--dsw-alias-label-secondary:\s*var\(--muted\)/)
  assert.match(css, /prefers-reduced-motion:\s*reduce/)
  assert.match(css, /pointer-events:\s*none/)
})
