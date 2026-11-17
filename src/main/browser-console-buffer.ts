import type { BrowserConsoleEntry } from './browser-debug-types.js'

export const CONSOLE_PAGE_ENTRIES = 300
export const CONSOLE_TOTAL_ENTRIES = 1000

export interface ConsoleSlice {
  entries: BrowserConsoleEntry[]
  /** Messages in the window, counting each compressed repeat. */
  total: number
  truncated: boolean
  /** False when a message in the window was not recorded, or was evicted or cleared. */
  complete: boolean
}

/** Console history for the browser's pages. Every message takes the next sequence number,
 * so a test run can mark boundaries that eviction, clearing and compression cannot blur.
 * Each page keeps at most `perPage` entries and all pages together `total`; closed pages are
 * evicted first, then the page with the most entries. */
export class ConsoleBuffer {
  /** Oldest first. The Activity view reads this array directly. */
  entries: BrowserConsoleEntry[] = []
  private sequence = 0
  private boundary = 0
  private lostAll = 0
  private readonly counts = new Map<number, number>()
  /** The newest sequence number that each page lost (not recorded, evicted or cleared). */
  private readonly lost = new Map<number, number>()
  /** The newest sequence number that each page used, recorded or not. */
  private readonly latest = new Map<number, number>()

  constructor(private readonly open: (pageId: number) => boolean = () => true,
    private readonly perPage = CONSOLE_PAGE_ENTRIES, private readonly total = CONSOLE_TOTAL_ENTRIES) {}

  /** The latest sequence number. A repeat after a mark always starts a new entry. */
  mark(): number { this.boundary = this.sequence; return this.sequence }

  add(message: Omit<BrowserConsoleEntry, 'id' | 'count' | 'lastId' | 'lastTimestamp'>): number {
    const id = ++this.sequence
    const previous = this.latest.get(message.pageId) ?? 0
    this.latest.set(message.pageId, id)
    const last = this.entries.findLast(entry => entry.pageId === message.pageId)
    // Only an uninterrupted run of one message is compressed, and never across a mark.
    if (last && (last.lastId ?? last.id) === previous && previous > this.boundary
      && last.level === message.level && last.message === message.message && last.source === message.source && last.line === message.line) {
      last.count = (last.count ?? 1) + 1; last.lastId = id; last.lastTimestamp = message.timestamp
      return id
    }
    this.entries.push({ id, ...message })
    this.counts.set(message.pageId, (this.counts.get(message.pageId) ?? 0) + 1)
    if (this.counts.get(message.pageId)! > this.perPage) this.evict(message.pageId)
    while (this.entries.length > this.total) {
      const closed = this.entries.find(entry => !this.open(entry.pageId))
      let largest = message.pageId
      for (const [pageId, count] of this.counts) if (count > (this.counts.get(largest) ?? 0)) largest = pageId
      this.evict(closed ? closed.pageId : largest)
    }
    return id
  }

  /** A message that arrived while recording was off still takes a sequence number, so a slice knows it is missing. */
  drop(pageId: number): void {
    const id = ++this.sequence
    this.latest.set(pageId, id); this.lost.set(pageId, id)
  }

  clear(pageId?: number): void {
    if (pageId === undefined) {
      this.lostAll = this.sequence; this.entries = []; this.counts.clear()
      return
    }
    this.lost.set(pageId, this.sequence); this.counts.delete(pageId)
    this.entries = this.entries.filter(entry => entry.pageId !== pageId)
  }

  /** Messages of one page with a sequence number in (after, through]. Errors are kept first when the slice is capped. */
  slice(pageId: number, after: number, through = this.sequence, max = 100): ConsoleSlice {
    const window = this.entries.filter(entry => entry.pageId === pageId && entry.id > after && entry.id <= through)
    const total = window.reduce((sum, entry) => sum + (entry.count ?? 1), 0)
    let kept = window
    if (window.length > max) {
      const errors = window.filter(entry => entry.level === 'error').slice(-max)
      const others = window.filter(entry => entry.level !== 'error')
      kept = [...errors, ...others.slice(others.length - (max - errors.length))].sort((a, b) => a.id - b.id)
    }
    return { entries: kept.map(entry => ({ ...entry })), total, truncated: kept.length < window.length,
      complete: Math.max(this.lost.get(pageId) ?? 0, this.lostAll) <= after }
  }

  private evict(pageId: number): void {
    const index = this.entries.findIndex(entry => entry.pageId === pageId)
    if (index < 0) return
    const [removed] = this.entries.splice(index, 1)
    this.lost.set(pageId, Math.max(this.lost.get(pageId) ?? 0, removed!.lastId ?? removed!.id))
    const count = (this.counts.get(pageId) ?? 1) - 1
    if (count > 0) this.counts.set(pageId, count); else this.counts.delete(pageId)
  }
}
