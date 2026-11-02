import { BrowserWindow, desktopCapturer, nativeImage, screen } from 'electron'
import { blankRects, intersectRect, screenRectToFrame, type DesktopRect } from './desktop-control-rules.js'
import type { DesktopDisplay } from './desktop-control.js'

/** Displays in physical pixels, which is what Win32 window bounds and input use. */
export function desktopDisplays(): DesktopDisplay[] {
  const primary = screen.getPrimaryDisplay().id
  return screen.getAllDisplays().map(display => ({
    id: display.id,
    bounds: screen.dipToScreenRect(null, display.bounds),
    scaleFactor: display.scaleFactor,
    primary: display.id === primary,
  }))
}

/**
 * Capture a physical screen area as a BGRA image of `size`: every display it touches is captured, cropped and scaled
 * into place, and the rectangles in `blank` are painted over. Windows with content protection, like the on-screen
 * banner, are left out by Windows itself.
 */
export async function captureDesktopArea(bounds: DesktopRect, size: { width: number; height: number }, blank: DesktopRect[]): Promise<Buffer> {
  const displays = desktopDisplays().filter(display => intersectRect(display.bounds, bounds))
  if (displays.length === 0) throw new Error('That area is not on any display.')
  const largest = { width: Math.max(...displays.map(display => display.bounds.width)), height: Math.max(...displays.map(display => display.bounds.height)) }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: largest, fetchWindowIcons: false })
  const output = Buffer.alloc(size.width * size.height * 4)
  for (let offset = 0; offset < output.length; offset += 4) { output[offset] = 17; output[offset + 1] = 17; output[offset + 2] = 17; output[offset + 3] = 255 }
  const frame = { bounds, width: size.width, height: size.height }
  for (const display of displays) {
    const source = sources.find(entry => entry.display_id === String(display.id))
    if (!source || source.thumbnail.isEmpty()) throw new Error('A display could not be captured; the screen may be locked.')
    const image = source.thumbnail.getSize()
    const part = intersectRect(display.bounds, bounds)!
    const rx = image.width / display.bounds.width
    const ry = image.height / display.bounds.height
    const crop = {
      x: Math.max(0, Math.floor((part.x - display.bounds.x) * rx)),
      y: Math.max(0, Math.floor((part.y - display.bounds.y) * ry)),
      width: Math.max(1, Math.round(part.width * rx)),
      height: Math.max(1, Math.round(part.height * ry)),
    }
    const target = screenRectToFrame(frame, part)
    const left = Math.max(0, target.x)
    const top = Math.max(0, target.y)
    const width = Math.min(size.width - left, target.width)
    const height = Math.min(size.height - top, target.height)
    if (width <= 0 || height <= 0) continue
    const piece = source.thumbnail.crop(crop).resize({ width, height, quality: 'best' })
    const pieceSize = piece.getSize()
    const bitmap = piece.toBitmap()
    for (let row = 0; row < Math.min(height, pieceSize.height); row++) {
      const from = row * pieceSize.width * 4
      bitmap.copy(output, ((top + row) * size.width + left) * 4, from, from + Math.min(width, pieceSize.width) * 4)
    }
  }
  blankRects(output, size, blank.map(rect => screenRectToFrame(frame, rect)))
  return output
}

export function encodeDesktopPng(bitmap: Buffer, size: { width: number; height: number }): Buffer {
  return nativeImage.createFromBitmap(bitmap, size).toPNG()
}

const OVERLAY_HTML = (paused: boolean, stopKey: string): string => `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:transparent;font:600 13px "Segoe UI",system-ui,sans-serif}
.edge{position:fixed;inset:0;border:3px solid ${paused ? '#d29922' : '#e5534b'};box-sizing:border-box}
.banner{position:fixed;top:8px;left:50%;transform:translateX(-50%);padding:6px 14px;border-radius:6px;color:#fff;
background:${paused ? '#9e6a03' : '#c93c37'};box-shadow:0 2px 8px rgba(0,0,0,.35);white-space:nowrap}
</style><div class="edge"></div><div class="banner">${paused
  ? 'Copilot desktop control is paused — resume it from the session’s Desktop control panel'
  : `Copilot is controlling your computer — press ${stopKey} to stop`}</div>`

/**
 * The always-visible sign that desktop control is on: a coloured edge and banner on every display. The windows ignore
 * the mouse (input passes through to the apps beneath) and are left out of every screenshot.
 */
export class DesktopOverlay {
  private windows: BrowserWindow[] = []
  private state: { active: boolean; paused: boolean } = { active: false, paused: false }
  private readonly rebuild = (): void => { if (this.state.active) this.show(true) }

  constructor(private readonly stopKey: string) {
    screen.on('display-added', this.rebuild)
    screen.on('display-removed', this.rebuild)
    screen.on('display-metrics-changed', this.rebuild)
  }

  update(state: { active: boolean; paused: boolean }): void {
    const changed = state.active !== this.state.active || state.paused !== this.state.paused
    this.state = state
    if (!state.active) { this.hide(); return }
    if (changed || this.windows.length === 0) this.show(false)
  }

  private show(rebuild: boolean): void {
    if (rebuild) this.hide()
    const html = `data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_HTML(this.state.paused, this.stopKey))}`
    if (this.windows.length === 0) {
      for (const display of screen.getAllDisplays()) {
        const window = new BrowserWindow({
          ...display.bounds, show: false, frame: false, transparent: true, resizable: false, movable: false, minimizable: false,
          maximizable: false, fullscreenable: false, focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true,
          title: 'Copilot desktop control',
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, spellcheck: false, devTools: false },
        })
        window.setAlwaysOnTop(true, 'screen-saver')
        window.setIgnoreMouseEvents(true)
        window.setContentProtection(true)
        window.setVisibleOnAllWorkspaces(true)
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        window.webContents.on('will-navigate', event => event.preventDefault())
        window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
        window.once('ready-to-show', () => { if (!window.isDestroyed()) window.showInactive() })
        this.windows.push(window)
      }
    }
    for (const window of this.windows) if (!window.isDestroyed()) void window.loadURL(html).catch(() => {})
  }

  private hide(): void {
    for (const window of this.windows) if (!window.isDestroyed()) window.destroy()
    this.windows = []
  }

  dispose(): void {
    screen.off('display-added', this.rebuild)
    screen.off('display-removed', this.rebuild)
    screen.off('display-metrics-changed', this.rebuild)
    this.hide()
  }
}
