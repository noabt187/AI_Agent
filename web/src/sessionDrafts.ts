type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type Draft = { text: string; revision: number }
const prefix = 'ai-agent:draft:v1:'

export class SessionDraftStore {
  private readonly drafts = new Map<string, Draft>()
  constructor(private readonly storage?: StorageLike) {}
  get(id: string): Draft {
    if (!this.drafts.has(id)) {
      let text = ''
      try { text = this.storage?.getItem(prefix + encodeURIComponent(id)) ?? '' } catch { /* memory fallback */ }
      this.drafts.set(id, { text, revision: 0 })
    }
    return { ...this.drafts.get(id)! }
  }
  set(id: string, text: string): void {
    this.drafts.set(id, { text, revision: this.get(id).revision + 1 })
    try {
      if (text) this.storage?.setItem(prefix + encodeURIComponent(id), text)
      else this.storage?.removeItem(prefix + encodeURIComponent(id))
    } catch { /* private mode / quota: keep in memory */ }
  }
  accept(id: string, revision: number): void {
    if (this.get(id).revision === revision) this.set(id, '')
  }
}

export function browserDraftStore(): SessionDraftStore {
  try { return new SessionDraftStore(window.sessionStorage) } catch { return new SessionDraftStore() }
}
