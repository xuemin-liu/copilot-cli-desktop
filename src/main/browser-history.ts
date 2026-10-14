import { readFileSync } from 'node:fs'
import { writeFileAtomic } from './atomic-file.js'
import { restorableUrl } from './browser-privacy.js'

const MAX_HISTORY = 200

/** Address-bar suggestions, newest first. Shared by every session's browser and, with a file, kept across launches.
 * Entries are restorable URLs only (origin and path), the same form saved for a session's page. */
export class BrowserHistory {
  private readonly entries: string[] = []
  private writing = Promise.resolve()

  constructor(private readonly file?: string, private readonly reportError: (message: string) => void = message => console.warn(message)) {
    if (!file) return
    let saved: unknown
    try { saved = JSON.parse(readFileSync(file, 'utf8')) as unknown }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reportError(`Could not read browser history: ${String(error)}`)
      return
    }
    if (!Array.isArray(saved)) return
    for (const entry of saved) {
      if (this.entries.length >= MAX_HISTORY) break
      let url: string | null = null
      try { url = typeof entry === 'string' ? restorableUrl(entry) : null } catch { /* Drop entries that are no longer restorable. */ }
      if (url && !this.entries.includes(url)) this.entries.push(url)
    }
  }

  list(): string[] { return [...this.entries] }

  record(url: string): void {
    let saved: string | null
    try { saved = restorableUrl(url) } catch { return }
    if (!saved) return
    const existing = this.entries.indexOf(saved)
    if (existing === 0) return
    if (existing > 0) this.entries.splice(existing, 1)
    this.entries.unshift(saved)
    if (this.entries.length > MAX_HISTORY) this.entries.length = MAX_HISTORY
    this.save()
  }

  clear(): void {
    this.entries.length = 0
    this.save()
  }

  private save(): void {
    const file = this.file
    if (!file) return
    const saved = JSON.stringify(this.entries)
    this.writing = this.writing.catch(() => {}).then(() => writeFileAtomic(file, saved))
    void this.writing.catch(error => this.reportError(`Could not save browser history: ${String(error)}`))
  }

  /** Resolves once queued writes have finished. */
  async flush(): Promise<void> { await this.writing.catch(() => {}) }
}
