import { readFileSync } from 'node:fs'
import { writeFileAtomic } from './atomic-file.js'

/** Chrome's page zoom steps. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const

/** The next step in the given direction, or 1 to reset. Starts from the nearest step when the factor is between two. */
export function nextZoomFactor(current: number, direction: 'in' | 'out' | 'reset'): number {
  if (direction === 'reset' || !Number.isFinite(current) || current <= 0) return 1
  let nearest = 0
  for (let index = 1; index < ZOOM_STEPS.length; index++) {
    if (Math.abs(ZOOM_STEPS[index]! - current) < Math.abs(ZOOM_STEPS[nearest]! - current)) nearest = index
  }
  const next = direction === 'in'
    ? (ZOOM_STEPS[nearest]! > current + 1e-6 ? nearest : nearest + 1)
    : (ZOOM_STEPS[nearest]! < current - 1e-6 ? nearest : nearest - 1)
  return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, next))]!
}

const MAX_SITES = 500
const isZoomFactor = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= ZOOM_STEPS[0] && value <= ZOOM_STEPS[ZOOM_STEPS.length - 1]!

/** The site a zoom level belongs to: the host name of an http(s) page, as Chrome keys zoom. */
export function zoomSite(url: string): string | null {
  try {
    const parsed = new URL(url)
    return /^https?:$/.test(parsed.protocol) && parsed.hostname ? parsed.hostname : null
  } catch { return null }
}

/** Page zoom by site, shared by every session's browser like one Chrome profile and, with a file, kept across launches. */
export class BrowserZoom {
  private readonly levels = new Map<string, number>()
  private readonly listeners = new Set<(site: string, factor: number) => void>()
  private writing = Promise.resolve()

  constructor(private readonly file?: string, private readonly reportError: (message: string) => void = message => console.warn(message)) {
    if (!file) return
    let saved: unknown
    try { saved = JSON.parse(readFileSync(file, 'utf8')) as unknown }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reportError(`Could not read browser zoom: ${String(error)}`)
      return
    }
    if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return
    for (const [site, factor] of Object.entries(saved).slice(-MAX_SITES)) {
      if (zoomSite(`http://${site}/`) === site && isZoomFactor(factor) && factor !== 1) this.levels.set(site, factor)
    }
  }

  /** The saved zoom for the page's site, or 1 (100%). */
  get(url: string): number {
    const site = zoomSite(url)
    return (site && this.levels.get(site)) || 1
  }

  /** Saves the zoom for the page's site and tells every browser showing that site. */
  set(url: string, factor: number): void {
    const site = zoomSite(url)
    if (!site || !isZoomFactor(factor) || this.get(url) === factor) return
    this.levels.delete(site)
    if (factor !== 1) {
      this.levels.set(site, factor)
      if (this.levels.size > MAX_SITES) this.levels.delete(this.levels.keys().next().value!)
    }
    for (const listener of this.listeners) listener(site, factor)
    const file = this.file
    if (!file) return
    const saved = JSON.stringify(Object.fromEntries(this.levels))
    this.writing = this.writing.catch(() => {}).then(() => writeFileAtomic(file, saved))
    void this.writing.catch(error => this.reportError(`Could not save browser zoom: ${String(error)}`))
  }

  /** Calls `listener` when a site's zoom changes; returns the unsubscribe function. */
  subscribe(listener: (site: string, factor: number) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Resolves once queued writes have finished. */
  async flush(): Promise<void> { await this.writing.catch(() => {}) }
}
