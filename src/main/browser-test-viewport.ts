export interface TestViewport { width: number; height: number; dpr: number }
/** Run-owned emulation. Capture still uses the reader's layout checks and opaque bitmap masks. */
export class BrowserTestViewport {
  private original?: TestViewport
  private requested?: TestViewport
  private possible = false
  private closed = false
  private cleanup?: Promise<void>
  private restored = false
  private cleanupFailed = false
  constructor(private readonly send: (method: string, params: Record<string, unknown>) => Promise<unknown>,
    private readonly read: () => Promise<TestViewport>, private readonly detach: () => void) {}
  get current(): TestViewport | undefined { return this.closed ? undefined : this.requested }
  async initialize(): Promise<void> { this.original = await this.read() }
  async apply(viewport: TestViewport): Promise<void> {
    if (this.closed || !this.original) throw new Error('Viewport run is unavailable.')
    if (viewport.width > this.original.width || viewport.height > this.original.height) throw new Error('Test viewport must fit inside the original visible page surface.')
    this.possible = true; this.requested = { ...viewport }
    await this.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.dpr, mobile: false })
    if (this.closed) throw new Error('Viewport run ended before emulation was acknowledged.')
    const actual = await this.read()
    if (actual.width !== viewport.width || actual.height !== viewport.height || Math.abs(actual.dpr - viewport.dpr) > 0.0001) throw new Error('Emulated viewport geometry does not match the requested CSS size/DPR.')
  }
  stop(): Promise<void> {
    this.closed = true
    return this.cleanup ??= (async () => {
      if (!this.possible) { this.restored = true; return }
      try {
        await this.send('Emulation.clearDeviceMetricsOverride', {})
        const actual = await this.read()
        this.restored = Boolean(this.original && actual.width === this.original.width && actual.height === this.original.height && Math.abs(actual.dpr - this.original.dpr) < 0.0001)
        if (!this.restored) throw new Error('Original geometry was not restored.')
      } catch { this.cleanupFailed = true; this.detach() }
    })()
  }
  evidence(): Record<string, unknown> { return { original: this.original, requested: this.requested, applied: this.possible, restored: this.restored, cleanupFailed: this.cleanupFailed,
    capture: 'Chromium surface capture with pre/post layout checks and opaque bitmap masks; no rescaling.' } }
}
