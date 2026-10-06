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

/** Per-session memory of the user's answers. Answers last until the user removes them or the app quits. */
export class SitePermissions {
  private readonly entries = new Map<string, SitePermissionEntry>()
  private readonly pending = new Map<string, Promise<boolean>>()
  private queue: Promise<unknown> = Promise.resolve()
  private sequence = 0

  /** `ask` resolves true to allow, false to block, or null when the prompt was dismissed (nothing is remembered). */
  constructor(private readonly ask: (origin: string, permission: SitePermission, signal: AbortSignal) => Promise<boolean | null>) {}

  private key(origin: string, permission: SitePermission): string { return `${origin}\n${permission}` }

  /** Synchronous answers (Chromium's permission checks) can only confirm what the user already allowed. */
  allowed(origin: string, permission: SitePermission): boolean {
    return this.entries.get(this.key(origin, permission))?.decision === 'allow'
  }

  request(origin: string, permission: SitePermission, signal: AbortSignal): Promise<boolean> {
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
      if (signal.aborted) return false
      const allow = await this.ask(origin, permission, signal)
      // A dismissed prompt, or a page that went away while it was open, remembers nothing.
      if (allow === null || signal.aborted) return false
      this.entries.set(key, { id: ++this.sequence, origin, permission, label: SITE_PERMISSIONS[permission], decision: allow ? 'allow' : 'block' })
      return allow
    }).finally(() => { this.pending.delete(key) })
    this.queue = answer.catch(() => {})
    this.pending.set(key, answer)
    return answer
  }

  list(): SitePermissionEntry[] { return [...this.entries.values()].map(entry => ({ ...entry })) }

  forget(id: number): boolean {
    for (const [key, entry] of this.entries) if (entry.id === id) { this.entries.delete(key); return true }
    return false
  }

  clear(): void { this.entries.clear() }
}
