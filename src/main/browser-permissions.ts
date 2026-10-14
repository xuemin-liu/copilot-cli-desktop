import { readFileSync } from 'node:fs'
import { writeFileAtomic } from './atomic-file.js'

/** Site permissions the session browser can grant after the user answers a native prompt.
 * Everything else (camera, microphone, location, screen capture, USB and so on) stays blocked. */
export const SITE_PERMISSIONS = {
  'clipboard-sanitized-write': 'copy text to your clipboard',
  'clipboard-read': 'read text from your clipboard',
  notifications: 'show desktop notifications',
} as const

export type SitePermission = keyof typeof SITE_PERMISSIONS

export interface SitePermissionEntry {
  id: number
  origin: string
  permission: SitePermission
  label: string
  decision: 'allow' | 'block'
}

const MAX_ENTRIES = 50

/** The origin that may be asked, or null when the request must be refused without asking. */
export function sitePermissionTarget(permission: string, url: string | undefined, isMainFrame: boolean | undefined): { origin: string; permission: SitePermission } | null {
  if (!isMainFrame || !url || !Object.hasOwn(SITE_PERMISSIONS, permission)) return null
  try {
    const parsed = new URL(url)
    return /^https?:$/.test(parsed.protocol) ? { origin: parsed.origin, permission: permission as SitePermission } : null
  } catch { return null }
}

/** Resolves true to allow, false to block, or null when the prompt was dismissed (nothing is remembered). */
export type AskSitePermission = (origin: string, permission: SitePermission, signal: AbortSignal) => Promise<boolean | null>

/** The user's answers, shared by every session's browser like one Chrome profile. With a file, answers are kept
 * across launches until the user removes them; without one, until the app quits. */
export class SitePermissions {
  private readonly entries = new Map<string, SitePermissionEntry>()
  private readonly pending = new Map<string, Promise<boolean>>()
  private queue: Promise<unknown> = Promise.resolve()
  private writing: Promise<void> = Promise.resolve()
  private sequence = 0

  /** `ask` is used when a request does not bring its own prompt. */
  constructor(private readonly ask: AskSitePermission = async () => null,
    private readonly options: { file?: string; reportError?: (message: string) => void } = {}) {
    if (!options.file) return
    let saved: unknown
    try { saved = JSON.parse(readFileSync(options.file, 'utf8')) as unknown }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.report(`Could not read site permissions: ${String(error)}`)
      return
    }
    if (!Array.isArray(saved)) return
    for (const entry of saved.slice(0, MAX_ENTRIES)) {
      if (typeof entry !== 'object' || entry === null) continue
      const { origin, permission, decision } = entry as Record<string, unknown>
      if (typeof origin !== 'string' || typeof permission !== 'string' || (decision !== 'allow' && decision !== 'block')) continue
      // Only an origin that could have been asked is restored, in the same form it was saved.
      const target = sitePermissionTarget(permission, origin, true)
      if (!target || target.origin !== origin) continue
      this.entries.set(this.key(origin, target.permission), { id: ++this.sequence, origin, permission: target.permission, label: SITE_PERMISSIONS[target.permission], decision })
    }
  }

  private report(message: string): void { (this.options.reportError ?? (text => console.warn(text)))(message) }

  private save(): void {
    const file = this.options.file
    if (!file) return
    const saved = [...this.entries.values()].map(({ origin, permission, decision }) => ({ origin, permission, decision }))
    this.writing = this.writing.catch(() => {}).then(() => writeFileAtomic(file, JSON.stringify(saved)))
    void this.writing.catch(error => this.report(`Could not save site permissions: ${String(error)}`))
  }

  /** Resolves once queued writes have finished. */
  async flush(): Promise<void> { await this.writing.catch(() => {}) }

  private key(origin: string, permission: SitePermission): string { return `${origin}\n${permission}` }

  /** Synchronous answers (Chromium's permission checks) can only confirm what the user already allowed. */
  allowed(origin: string, permission: SitePermission): boolean {
    return this.entries.get(this.key(origin, permission))?.decision === 'allow'
  }

  request(origin: string, permission: SitePermission, signal: AbortSignal, ask: AskSitePermission = this.ask): Promise<boolean> {
    const key = this.key(origin, permission)
    const known = this.entries.get(key)
    if (known) return Promise.resolve(known.decision === 'allow')
    const running = this.pending.get(key)
    if (running) return running
    // Entries are capped: past the cap unknown sites are blocked rather than prompting forever.
    if (this.entries.size >= MAX_ENTRIES) return Promise.resolve(false)
    // One native prompt at a time, so a page cannot stack dialogs.
    const answer = this.queue.then(async () => {
      const again = this.entries.get(key)
      if (again) return again.decision === 'allow'
      // Requests that arrived together all saw the same size above; capacity is decided here, one at a time.
      if (signal.aborted || this.entries.size >= MAX_ENTRIES) return false
      const allow = await ask(origin, permission, signal)
      // A dismissed prompt, or a page that went away while it was open, remembers nothing.
      if (allow === null || signal.aborted) return false
      this.entries.set(key, { id: ++this.sequence, origin, permission, label: SITE_PERMISSIONS[permission], decision: allow ? 'allow' : 'block' })
      this.save()
      return allow
    }).finally(() => { this.pending.delete(key) })
    this.queue = answer.catch(() => {})
    this.pending.set(key, answer)
    return answer
  }

  list(): SitePermissionEntry[] { return [...this.entries.values()].map(entry => ({ ...entry })) }

  forget(id: number): boolean {
    for (const [key, entry] of this.entries) if (entry.id === id) { this.entries.delete(key); this.save(); return true }
    return false
  }

  clear(): void {
    if (!this.entries.size) return
    this.entries.clear()
    this.save()
  }
}
