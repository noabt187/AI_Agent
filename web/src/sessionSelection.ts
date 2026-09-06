const key = 'agent-console-selected-session'

export function readSelectedSession(storage?: Pick<Storage, 'getItem'>): string {
  try { return storage?.getItem(key) || '' } catch { return '' }
}

export function saveSelectedSession(id: string, storage?: Pick<Storage, 'setItem' | 'removeItem'>): void {
  try {
    if (id) storage?.setItem(key, id)
    else storage?.removeItem(key)
  } catch { /* Storage can be disabled; selection still works in memory. */ }
}

export function selectExistingSession(ids: string[], preferred: string): string {
  return ids.includes(preferred) ? preferred : ids[0] || ''
}
