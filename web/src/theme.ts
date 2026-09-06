export type ThemeMode = 'dark' | 'light'
export const themeStorageKey = 'agent-console-theme'

// Keep appearance independent of Agent/session state. Restricted storage must
// never prevent the workspace from rendering.
export function readThemeMode(storage?: Pick<Storage, 'getItem'>): ThemeMode {
  try {
    const source = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage)
    return source?.getItem(themeStorageKey) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function saveThemeMode(mode: ThemeMode, storage?: Pick<Storage, 'setItem'>): void {
  try {
    const target = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage)
    target?.setItem(themeStorageKey, mode)
  } catch {
    // The selected theme remains usable for this visit without persistence.
  }
}
