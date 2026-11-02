import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { isAbsolute, join } from 'node:path'
import { constantTimeTokenEqual } from '../cli/runtime-core.js'
import { validateBrowserScreenshotPath } from '../cli/browser-control.js'
import { writeFileAtomic } from './atomic-file.js'
import {
  appDisplayName, canStartPrograms, DESKTOP_BLOCK_MESSAGES, DESKTOP_FRAME_MAX_AGE_MS, desktopBlockReason, desktopFrameSize,
  DesktopRateLimiter, framePointToScreen, identityKey, isFrameId, isWindowId, parseDesktopChord, patchesMatch, patchRect,
  rectContains, sameRect, validateDesktopText,
  type DesktopAppIdentity, type DesktopBlockReason, type DesktopRect,
} from './desktop-control-rules.js'
import type { DesktopInputMonitor, DesktopNativeLayer } from './desktop-native.js'
import type { DesktopNativeWindow } from './desktop-native-types.js'

/** What the renderer shows for one session. */
export interface DesktopControlTabView {
  enabled: boolean
  paused: boolean
  approvedApps: Array<{ key: string; name: string }>
  fullScreen: boolean
  log: DesktopControlLogEntry[]
}

export interface DesktopControlLogEntry {
  at: string
  command: string
  app?: string
  result: 'ok' | 'refused' | 'failed'
  message: string
}

export type DesktopApproval = 'deny' | 'once' | 'session'

export interface DesktopDisplay { id: number; bounds: DesktopRect; scaleFactor: number; primary: boolean }

export interface DesktopControlHost {
  /** This app's own program, whose windows are never controlled. */
  ownProgramPath: string
  /** Accelerators the app registers globally; `key` refuses them. */
  reservedAccelerators(): string[]
  stopKeyLabel: string
  /** The folder for a session's state file and screenshots. */
  sessionFolder(tabId: string): string
  /** Why a session may not use desktop control (read-only, remote, …), or null. */
  sessionRefusal(tabId: string): string | null
  sessionTitle(tabId: string): string
  approve(request: { tabId: string; app: string; detail: string; warning: string | null; screen: boolean }, signal: AbortSignal): Promise<DesktopApproval>
  displays(): DesktopDisplay[]
  /** The physical area as a BGRA image of `size`, with the physical rectangles in `blank` painted over. */
  capture(bounds: DesktopRect, size: { width: number; height: number }, blank: DesktopRect[]): Promise<Buffer>
  encodePng(bitmap: Buffer, size: { width: number; height: number }): Buffer
  /** Turn the on-screen banner and border on or off, and show whether control is paused. */
  overlay(state: { active: boolean; paused: boolean }): void
  /** Register or unregister the stop key. Returns false when it could not be registered. */
  stopKey(active: boolean, stop: () => void): boolean
  changed(): void
  locked(): boolean
  log(message: string): void
}

interface Frame {
  id: string
  tabId: string
  kind: 'window' | 'screen'
  windowId: string | null
  identity: string | null
  bounds: DesktopRect
  width: number
  height: number
  bitmap: Buffer
  blank: DesktopRect[]
  createdAt: number
  epoch: number
}

interface TabControl {
  token: string
  grants: Map<string, string>
  fullScreen: boolean
  paused: boolean
  busy: boolean
  frames: Frame[]
  aborts: Set<AbortController>
  idleTimer: NodeJS.Timeout | null
  limiter: DesktopRateLimiter
}

export class DesktopControlError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

const IDLE_MS = 30 * 60_000
const RECENT_INPUT_MS = 1_500
const MAX_FRAMES = 4
const MAX_LOG = 200
const TYPE_CHUNK = 32
const MAX_BODY = 64 * 1024
const COMMANDS = new Set(['status', 'windows', 'screenshot', 'click', 'move', 'drag', 'scroll', 'type', 'key', 'focus'])

interface Target { window: DesktopNativeWindow; identity: DesktopAppIdentity; key: string; name: string }

export function desktopControlStatePath(folder: string): string {
  return join(folder, 'desktop-control.json')
}

export class DesktopControl {
  private readonly tabs = new Map<string, TabControl>()
  private readonly logs = new Map<string, DesktopControlLogEntry[]>()
  private server: Server | null = null
  private serverStart: Promise<number> | null = null
  private epoch = 0
  private monitorRunning = false

  constructor(private readonly host: DesktopControlHost, private readonly native: DesktopNativeLayer, private readonly monitor: DesktopInputMonitor) {}

  isEnabled(tabId: string): boolean { return this.tabs.has(tabId) }

  enabledTabs(): string[] { return [...this.tabs.keys()] }

  view(tabId: string): DesktopControlTabView {
    const control = this.tabs.get(tabId)
    return {
      enabled: Boolean(control),
      paused: control?.paused ?? false,
      approvedApps: control ? [...control.grants].map(([key, name]) => ({ key, name })) : [],
      fullScreen: control?.fullScreen ?? false,
      log: (this.logs.get(tabId) ?? []).slice(-50),
    }
  }

  /** The screen locked, unlocked or changed: frames taken before can't be trusted. */
  invalidateFrames(): void { this.epoch++ }

  async enable(tabId: string): Promise<void> {
    if (this.tabs.has(tabId)) return
    const refusal = this.host.sessionRefusal(tabId)
    if (refusal) throw new DesktopControlError(refusal)
    // Only one session controls the desktop at a time; turning it on here turns it off elsewhere.
    for (const other of [...this.tabs.keys()]) await this.disable(other, 'Turned off: desktop control was turned on in another session.')
    if (!this.monitorRunning) {
      await this.monitor.start()
      this.monitorRunning = true
    }
    const port = await this.startServer()
    const control: TabControl = {
      token: randomBytes(32).toString('hex'), grants: new Map(), fullScreen: false, paused: false, busy: false, frames: [],
      aborts: new Set(), idleTimer: null, limiter: new DesktopRateLimiter(10),
    }
    const folder = this.host.sessionFolder(tabId)
    await writeFileAtomic(desktopControlStatePath(folder), JSON.stringify({ pid: process.pid, port, token: control.token }))
    this.tabs.set(tabId, control)
    if (!this.host.stopKey(true, () => { void this.disableAll('Stopped with the stop key.') })) {
      await this.disable(tabId, 'Turned off: the stop key could not be registered.')
      throw new DesktopControlError(`The stop key (${this.host.stopKeyLabel}) is in use by another app, so desktop control stays off.`)
    }
    this.touch(tabId)
    this.record(tabId, { command: 'on', result: 'ok', message: 'Desktop control turned on.' })
    this.refreshOverlay()
    this.host.changed()
  }

  async disable(tabId: string, message = 'Desktop control turned off.'): Promise<void> {
    const control = this.tabs.get(tabId)
    if (!control) return
    this.tabs.delete(tabId)
    if (control.idleTimer) clearTimeout(control.idleTimer)
    for (const abort of control.aborts) abort.abort()
    control.frames.length = 0
    await removeStateFile(desktopControlStatePath(this.host.sessionFolder(tabId)), control.token)
    this.record(tabId, { command: 'off', result: 'ok', message })
    if (this.tabs.size === 0) {
      this.host.stopKey(false, () => {})
      if (this.monitorRunning) {
        this.monitorRunning = false
        await this.monitor.stop().catch(() => {})
      }
    }
    this.refreshOverlay()
    this.host.changed()
  }

  async disableAll(message: string): Promise<void> {
    for (const tabId of [...this.tabs.keys()]) await this.disable(tabId, message)
  }

  resume(tabId: string): void {
    const control = this.tabs.get(tabId)
    if (!control?.paused) return
    control.paused = false
    this.record(tabId, { command: 'resume', result: 'ok', message: 'Resumed by the user.' })
    this.refreshOverlay()
    this.host.changed()
  }

  revoke(tabId: string, key: string): void {
    const control = this.tabs.get(tabId)
    if (!control?.grants.delete(key)) return
    this.host.changed()
  }

  setFullScreen(tabId: string, allowed: boolean): void {
    const control = this.tabs.get(tabId)
    if (!control || control.fullScreen === allowed) return
    control.fullScreen = allowed
    this.host.changed()
  }

  /** A session closed: forget its control and its log. */
  async forget(tabId: string): Promise<void> {
    await this.disable(tabId)
    this.logs.delete(tabId)
  }

  async dispose(): Promise<void> {
    await this.disableAll('Desktop control turned off: the app is closing.')
    const server = this.server
    this.server = null
    this.serverStart = null
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    await this.native.dispose().catch(() => {})
  }

  private refreshOverlay(): void {
    const controls = [...this.tabs.values()]
    this.host.overlay({ active: controls.length > 0, paused: controls.some(control => control.paused) })
  }

  private touch(tabId: string): void {
    const control = this.tabs.get(tabId)
    if (!control) return
    if (control.idleTimer) clearTimeout(control.idleTimer)
    control.idleTimer = setTimeout(() => { void this.disable(tabId, 'Turned off after 30 minutes without an action.') }, IDLE_MS)
    control.idleTimer.unref()
  }

  private record(tabId: string, entry: Omit<DesktopControlLogEntry, 'at'>): void {
    const log = this.logs.get(tabId) ?? []
    log.push({ at: new Date().toISOString(), ...entry })
    if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG)
    this.logs.set(tabId, log)
  }

  private pause(tabId: string, message: string): void {
    const control = this.tabs.get(tabId)
    if (!control || control.paused) return
    control.paused = true
    this.record(tabId, { command: 'pause', result: 'ok', message })
    this.refreshOverlay()
    this.host.changed()
  }

  // Requests

  /** Handle one helper request for a session; every refusal is logged and thrown as a DesktopControlError. */
  async handle(tabId: string, command: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const control = this.tabs.get(tabId)
    if (!control) throw new DesktopControlError('Desktop control is off for this session. Ask the user to turn it on from the session’s toolbar.', 409)
    if (!COMMANDS.has(command)) throw new DesktopControlError(`Unknown desktop command: ${command}`, 404)
    this.touch(tabId)
    if (command === 'status') return this.status(tabId, control)
    if (control.paused) throw this.refuse(tabId, command, undefined, 'Desktop control is paused because the user used the mouse or keyboard. Ask the user to click Resume in the session’s Desktop control panel.', 409)
    if (control.busy) throw this.refuse(tabId, command, undefined, 'Another desktop action is still running; wait for it to finish.', 409)
    control.busy = true
    try {
      if (this.host.locked() || !await this.native.desktopAvailable()) throw new DesktopControlError('The desktop isn’t available (it is locked, or a sign-in or administrator prompt is showing).', 409)
      switch (command) {
        case 'windows': return await this.windows(tabId)
        case 'screenshot': return await this.screenshot(tabId, control, body)
        case 'focus': return await this.focus(tabId, control, body)
        default: return await this.input(tabId, control, command, body)
      }
    } catch (error) {
      if (error instanceof DesktopControlError && !(error as { logged?: boolean }).logged) this.record(tabId, { command, result: 'refused', message: error.message })
      else if (!(error instanceof DesktopControlError)) this.record(tabId, { command, result: 'failed', message: error instanceof Error ? error.message : String(error) })
      this.host.changed()
      throw error
    } finally {
      control.busy = false
    }
  }

  private refuse(tabId: string, command: string, app: string | undefined, message: string, status = 400): DesktopControlError {
    this.record(tabId, { command, ...(app ? { app } : {}), result: 'refused', message })
    this.host.changed()
    const error = new DesktopControlError(message, status) as DesktopControlError & { logged?: boolean }
    error.logged = true
    return error
  }

  private status(tabId: string, control: TabControl): Record<string, unknown> {
    return {
      enabled: true,
      paused: control.paused,
      stopKey: this.host.stopKeyLabel,
      approvedApps: [...control.grants.values()],
      fullScreenAllowed: control.fullScreen,
      displays: this.host.displays().map((display, index) => ({ index, primary: display.primary, width: display.bounds.width, height: display.bounds.height, scale: display.scaleFactor })),
      session: this.host.sessionTitle(tabId),
    }
  }

  private identityOf(window: DesktopNativeWindow): DesktopAppIdentity | null {
    if (window.aumid) return { kind: 'package', aumid: window.aumid }
    if (window.programPath && isAbsolute(window.programPath)) return { kind: 'program', path: window.programPath }
    return null
  }

  private blockReason(window: DesktopNativeWindow): DesktopBlockReason | null {
    return desktopBlockReason({ identity: this.identityOf(window), className: window.className, elevated: window.elevated }, this.host.ownProgramPath)
  }

  private target(window: DesktopNativeWindow): Target | { blocked: DesktopBlockReason; window: DesktopNativeWindow } {
    const blocked = this.blockReason(window)
    const identity = this.identityOf(window)
    if (blocked || !identity) return { blocked: blocked ?? 'unidentified', window }
    return { window, identity, key: identityKey(identity), name: appDisplayName(identity) }
  }

  /**
   * Ask the person, then put back the window that was in front: the prompt raises this app's window, which would
   * otherwise cover the app Copilot is about to capture or click.
   */
  private async ask(tabId: string, control: TabControl, request: Omit<Parameters<DesktopControlHost['approve']>[0], 'tabId'>): Promise<DesktopApproval> {
    const abort = new AbortController()
    control.aborts.add(abort)
    const front = await this.native.foreground().catch(() => null)
    try {
      const answer = await this.host.approve({ tabId, ...request }, abort.signal)
      if (!this.tabs.has(tabId)) throw new DesktopControlError('Desktop control was turned off.', 409)
      if (answer !== 'deny' && front) {
        await this.native.focus(front).catch(() => false)
        await new Promise(resolve => setTimeout(resolve, 150))
      }
      return answer
    } finally { control.aborts.delete(abort) }
  }

  /** Ask the user to approve an app for this session, unless it already is. */
  private async approveApp(tabId: string, control: TabControl, command: string, target: Target): Promise<'once' | 'session'> {
    if (control.grants.has(target.key)) return 'session'
    const warning = canStartPrograms(target.identity)
      ? `${target.name} can open files and start programs. Approving it lets Copilot start programs from it, outside Copilot CLI’s shell approvals.`
      : null
    const detail = target.identity.kind === 'program' ? target.identity.path : target.identity.aumid
    const answer = await this.ask(tabId, control, { app: target.name, detail, warning, screen: false })
    if (answer === 'deny') throw this.refuse(tabId, command, target.name, `The user did not allow Copilot to control ${target.name}.`, 403)
    if (answer === 'session') { control.grants.set(target.key, target.name); this.host.changed() }
    return answer
  }

  private async windows(tabId: string): Promise<Record<string, unknown>> {
    const windows = await this.native.windows()
    const control = this.tabs.get(tabId)
    return {
      windows: windows.filter(window => !window.clickThrough && (window.title || !window.toolWindow)).map(window => {
        const target = this.target(window)
        const blocked = 'blocked' in target
        return {
          id: window.id,
          app: blocked ? (window.programPath ? appDisplayName({ kind: 'program', path: window.programPath }) : window.className) : target.name,
          // A blocked window's title may name an account or a password entry; it is not shown.
          title: blocked ? '' : window.title.slice(0, 160),
          status: blocked ? `blocked: ${DESKTOP_BLOCK_MESSAGES[target.blocked]}` : control?.grants.has(target.key) ? 'approved' : 'needs approval',
          minimized: window.minimized,
        }
      }),
    }
  }

  private windowsAbove(windows: DesktopNativeWindow[], id: string): DesktopNativeWindow[] {
    const index = windows.findIndex(window => window.id === id)
    return index < 0 ? [] : windows.slice(0, index)
  }

  private blankFor(frameKind: 'window' | 'screen', windows: DesktopNativeWindow[], targetWindow: DesktopNativeWindow | null, targetKey: string | null): DesktopRect[] {
    if (frameKind === 'window' && targetWindow) {
      // Show the target and its own popups and menus; paint over every other app's window in front of it.
      return this.windowsAbove(windows, targetWindow.id)
        .filter(window => !window.clickThrough && !window.minimized && (() => { const t = this.target(window); return 'blocked' in t || t.key !== targetKey })())
        .map(window => window.bounds)
    }
    return windows.filter(window => !window.clickThrough && !window.minimized && this.blockReason(window) !== null).map(window => window.bounds)
  }

  private async screenshot(tabId: string, control: TabControl, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requested = body.target
    const windows = await this.native.windows()
    let frame: Omit<Frame, 'bitmap' | 'id' | 'createdAt' | 'epoch'>
    let app: string | undefined
    if (typeof requested === 'string' && /^screen(:\d)?$/.test(requested)) {
      const displays = this.host.displays()
      const index = requested === 'screen' ? Math.max(0, displays.findIndex(display => display.primary)) : Number(requested.slice(7))
      const display = displays[index]
      if (!display) throw new DesktopControlError(`There is no display ${index}; run status to list them.`)
      if (!control.fullScreen) {
        const answer = await this.ask(tabId, control, { app: 'your whole screen', detail: `Display ${index} (${display.bounds.width}×${display.bounds.height})`, warning: 'A full-screen capture shows every app on that display except blocked ones, which are painted over.', screen: true })
        if (answer === 'deny') throw this.refuse(tabId, 'screenshot', 'screen', 'The user did not allow a full-screen capture.', 403)
        if (answer === 'session') { control.fullScreen = true; this.host.changed() }
      }
      const size = desktopFrameSize(display.bounds)
      frame = { tabId, kind: 'screen', windowId: null, identity: null, bounds: display.bounds, ...size, blank: this.blankFor('screen', windows, null, null) }
      app = 'screen'
    } else {
      const id = requested === undefined || requested === null || requested === '' ? await this.native.foreground() : requested
      if (!isWindowId(id)) throw new DesktopControlError('Give a window id from the windows command, or screen for a full-screen capture.')
      const window = windows.find(entry => entry.id === id)
      if (!window) throw new DesktopControlError('That window is not open or not visible; run windows again.')
      const target = this.target(window)
      if ('blocked' in target) throw this.refuse(tabId, 'screenshot', undefined, DESKTOP_BLOCK_MESSAGES[target.blocked], 403)
      if (window.minimized) throw new DesktopControlError(`${target.name} is minimized; focus it first.`)
      await this.approveApp(tabId, control, 'screenshot', target)
      // An approval prompt changes which windows are in front: read them again.
      const current = await this.native.windows()
      const shown = current.find(entry => entry.id === window.id)
      if (!shown) throw new DesktopControlError('That window closed; run windows again.')
      const size = desktopFrameSize(shown.bounds)
      frame = { tabId, kind: 'window', windowId: shown.id, identity: target.key, bounds: shown.bounds, ...size, blank: this.blankFor('window', current, shown, target.key) }
      app = target.name
    }
    const bitmap = await this.host.capture(frame.bounds, { width: frame.width, height: frame.height }, frame.blank)
    const stored: Frame = { ...frame, bitmap, id: `f${randomBytes(6).toString('hex')}`, createdAt: Date.now(), epoch: this.epoch }
    control.frames.push(stored)
    if (control.frames.length > MAX_FRAMES) control.frames.splice(0, control.frames.length - MAX_FRAMES)
    const png = this.host.encodePng(bitmap, { width: frame.width, height: frame.height })
    const chosen = typeof body.outputPath === 'string' && body.outputPath ? body.outputPath : null
    if (chosen) validateBrowserScreenshotPath(chosen)
    const output = chosen ?? join(this.host.sessionFolder(tabId), 'desktop-screenshots', `${stored.id}.png`)
    await mkdir(join(output, '..'), { recursive: true })
    await writeFile(output, png, { flag: 'wx' })
    this.record(tabId, { command: 'screenshot', app, result: 'ok', message: `${frame.width}×${frame.height} frame ${stored.id}` })
    this.host.changed()
    return { frameId: stored.id, width: frame.width, height: frame.height, path: output, kind: frame.kind, ...(frame.windowId ? { windowId: frame.windowId } : {}) }
  }

  private async focus(tabId: string, control: TabControl, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!isWindowId(body.windowId)) throw new DesktopControlError('Give a window id from the windows command.')
    const window = (await this.native.windows()).find(entry => entry.id === body.windowId)
    if (!window) throw new DesktopControlError('That window is not open or not visible; run windows again.')
    const target = this.target(window)
    if ('blocked' in target) throw this.refuse(tabId, 'focus', undefined, DESKTOP_BLOCK_MESSAGES[target.blocked], 403)
    if (!control.limiter.take()) throw new DesktopControlError('Too many desktop actions; at most 10 a second.', 429)
    await this.approveApp(tabId, control, 'focus', target)
    const front = await this.native.focus(window.id)
    this.record(tabId, { command: 'focus', app: target.name, result: front ? 'ok' : 'failed', message: front ? 'Brought to the front.' : 'Windows did not bring it to the front.' })
    this.host.changed()
    return { focused: front, ...(front ? {} : { hint: 'Windows kept another window in front. Take a screenshot and click the window instead.' }) }
  }

  private frameFor(tabId: string, control: TabControl, command: string, frameId: unknown): Frame {
    if (!isFrameId(frameId)) throw new DesktopControlError('Give the frameId of the screenshot the action was planned from.')
    const frame = control.frames.find(entry => entry.id === frameId)
    if (!frame) throw this.refuse(tabId, command, undefined, 'That screenshot is no longer kept (only the last few are); take a new screenshot.', 409)
    if (Date.now() - frame.createdAt > DESKTOP_FRAME_MAX_AGE_MS || frame.epoch !== this.epoch) {
      throw this.refuse(tabId, command, undefined, 'The screen changed; take a new screenshot. (Screenshots older than 30 seconds are not used.)', 409)
    }
    return frame
  }

  private hitTest(windows: DesktopNativeWindow[], point: { x: number; y: number }): DesktopNativeWindow | null {
    return windows.find(window => !window.clickThrough && !window.minimized && rectContains(window.bounds, point)) ?? null
  }

  /** The window under a point must be an approved app that the frame showed; returns it, approving it if needed. */
  private async pointTarget(tabId: string, control: TabControl, command: string, frame: Frame, windows: DesktopNativeWindow[], point: { x: number; y: number }): Promise<Target> {
    if (frame.kind === 'window') {
      const framed = windows.find(window => window.id === frame.windowId)
      if (!framed || !sameRect(framed.bounds, frame.bounds)) throw this.refuse(tabId, command, undefined, 'The window moved, resized or closed; take a new screenshot.', 409)
    }
    const hit = this.hitTest(windows, point)
    if (!hit) throw this.refuse(tabId, command, undefined, 'There is no window at that point.', 409)
    const target = this.target(hit)
    if ('blocked' in target) throw this.refuse(tabId, command, undefined, `The point is on a blocked window. ${DESKTOP_BLOCK_MESSAGES[target.blocked]}`, 403)
    if (frame.kind === 'window' && target.key !== frame.identity) {
      throw this.refuse(tabId, command, target.name, `The point is on another app’s window (${target.name}); take a screenshot of that window first.`, 409)
    }
    await this.approveApp(tabId, control, command, target)
    return target
  }

  /** Re-capture the frame's area and compare the pixels around the point, so a dialog drawn since the screenshot is caught. */
  private async patchUnchanged(frame: Frame, windows: DesktopNativeWindow[], x: number, y: number): Promise<boolean> {
    const framed = frame.kind === 'window' ? windows.find(window => window.id === frame.windowId) ?? null : null
    const blank = this.blankFor(frame.kind, windows, framed, frame.identity)
    const now = await this.host.capture(frame.bounds, { width: frame.width, height: frame.height }, blank)
    return patchesMatch(frame.bitmap, now, frame, patchRect(frame, x, y))
  }

  private userInputSince(count: number): boolean {
    return this.monitor.read().count !== count
  }

  private async input(tabId: string, control: TabControl, command: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!control.limiter.take()) throw new DesktopControlError('Too many desktop actions; at most 10 a second.', 429)
    if (Date.now() - this.monitor.read().lastAt < RECENT_INPUT_MS) {
      throw this.refuse(tabId, command, undefined, 'The user is using the mouse or keyboard; try again in a moment.', 409)
    }
    const frame = this.frameFor(tabId, control, command, body.frameId)
    let windows = await this.native.windows()
    let target: Target
    let perform: () => Promise<void>
    let summary: string

    if (command === 'type' || command === 'key') {
      const chord = command === 'key' ? checked(() => parseDesktopChord(String(body.chord ?? ''), this.host.reservedAccelerators())) : null
      const text = command === 'type' ? checked(() => validateDesktopText(body.text)) : ''
      const foregroundId = await this.native.foreground()
      const foreground = windows.find(window => window.id === foregroundId)
      if (!foreground) throw this.refuse(tabId, command, undefined, 'No window has the keyboard focus.', 409)
      const resolved = this.target(foreground)
      if ('blocked' in resolved) throw this.refuse(tabId, command, undefined, `The window with the keyboard focus is blocked. ${DESKTOP_BLOCK_MESSAGES[resolved.blocked]}`, 403)
      if (frame.kind === 'window' && resolved.key !== frame.identity) {
        throw this.refuse(tabId, command, resolved.name, `The keyboard focus is in another app (${resolved.name}); focus the window from the screenshot first.`, 409)
      }
      await this.approveApp(tabId, control, command, resolved)
      target = resolved
      if (command === 'type') {
        const focused = await this.native.focused().catch(() => ({ pid: null, password: null }))
        if (focused.pid !== target.window.pid) throw this.refuse(tabId, command, target.name, 'Desktop control could not tell which control has the keyboard focus, so it did not type.', 409)
        if (focused.password !== false) throw this.refuse(tabId, command, target.name, 'The focused control is a password field (or could not be checked), so desktop control did not type. Ask the user to enter it.', 403)
      }
      summary = command === 'type' ? `Typed ${text.length} characters.` : `Pressed ${[...chord!.modifiers, chord!.key].join('+')}.`
      perform = command === 'type'
        ? async () => {
          const before = this.monitor.read().count
          for (let index = 0; index < text.length; index += TYPE_CHUNK) {
            if (!this.tabs.has(tabId)) throw new DesktopControlError('Desktop control was turned off.', 409)
            if (this.userInputSince(before)) throw new DesktopControlError('USER_INPUT')
            await this.native.type(text.slice(index, index + TYPE_CHUNK))
          }
        }
        : () => this.native.key(chord!.vks)
    } else {
      const point = checked(() => framePointToScreen(frame, body.x, body.y))
      target = await this.pointTarget(tabId, control, command, frame, windows, point)
      if (command === 'click' || command === 'scroll' || command === 'drag') {
        windows = await this.native.windows()
        if (!await this.patchUnchanged(frame, windows, body.x as number, body.y as number)) {
          throw this.refuse(tabId, command, target.name, 'The screen changed around that point; take a new screenshot.', 409)
        }
        const hit = this.hitTest(windows, point)
        const now = hit ? this.target(hit) : null
        if (!now || 'blocked' in now || now.key !== target.key) {
          throw this.refuse(tabId, command, target.name, 'The screen changed; take a new screenshot.', 409)
        }
      }
      if (command === 'click') {
        const button = body.button === undefined ? 'left' : body.button
        if (button !== 'left' && button !== 'right' && button !== 'middle') throw new DesktopControlError('The button is left, right or middle.')
        const count = body.double === true ? 2 : 1
        summary = `${count === 2 ? 'Double-clicked' : 'Clicked'} ${button} at ${body.x},${body.y}.`
        perform = () => this.native.click(point.x, point.y, button, count)
      } else if (command === 'move') {
        summary = `Moved the pointer to ${body.x},${body.y}.`
        perform = () => this.native.move(point.x, point.y)
      } else if (command === 'scroll') {
        const dx = Number(body.dx ?? 0)
        const dy = Number(body.dy ?? 0)
        if (![dx, dy].every(value => Number.isInteger(value) && Math.abs(value) <= 20) || (dx === 0 && dy === 0)) throw new DesktopControlError('Scroll by whole steps between -20 and 20 (dy down is positive).')
        summary = `Scrolled ${dx},${dy} at ${body.x},${body.y}.`
        perform = () => this.native.scroll(point.x, point.y, dx, dy)
      } else {
        const to = checked(() => framePointToScreen(frame, body.toX, body.toY))
        const end = this.hitTest(windows, to)
        const endTarget = end ? this.target(end) : null
        if (!endTarget || 'blocked' in endTarget) throw this.refuse(tabId, command, target.name, 'The drag would end on a blocked window or on no window.', 403)
        await this.approveApp(tabId, control, command, endTarget)
        summary = `Dragged from ${body.x},${body.y} to ${body.toX},${body.toY}.`
        perform = () => this.native.drag(point, to)
      }
    }

    // The user may have clicked an approval prompt: their input from before the action does not count.
    const before = this.monitor.read().count
    try {
      await perform()
    } catch (error) {
      if (error instanceof DesktopControlError && error.message === 'USER_INPUT') {
        this.pause(tabId, 'Paused: the user typed or used the mouse while Copilot was typing.')
        throw this.refuse(tabId, command, target.name, 'The user used the mouse or keyboard during the action, so it stopped and desktop control paused.', 409)
      }
      throw error
    }
    if (this.userInputSince(before)) this.pause(tabId, 'Paused: the user used the mouse or keyboard during an action.')
    this.record(tabId, { command, app: target.name, result: 'ok', message: summary })
    this.host.changed()
    return { done: true, app: target.name, ...(this.tabs.get(tabId)?.paused ? { paused: true } : {}) }
  }

  // Loopback endpoint

  tokenTab(authorization: string): string | null {
    for (const [tabId, control] of this.tabs) if (constantTimeTokenEqual(authorization, `Bearer ${control.token}`)) return tabId
    return null
  }

  private startServer(): Promise<number> {
    if (this.serverStart) return this.serverStart
    this.serverStart = new Promise<number>((resolve, reject) => {
      const server = createServer((request, response) => { void this.serve(server, request, response) })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        this.server = server
        resolve((server.address() as { port: number }).port)
      })
    }).catch(error => { this.serverStart = null; throw error })
    return this.serverStart
  }

  private async serve(server: Server, request: IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      if (response.headersSent || response.destroyed) return
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify(body))
    }
    const port = (server.address() as { port: number } | null)?.port
    // No CORS; refuse browser-originated requests and DNS rebinding before authenticating.
    if (request.headers.origin || request.headers.host !== `127.0.0.1:${port}`) { send(403, { message: 'Forbidden' }); return }
    const tabId = this.tokenTab(request.headers.authorization ?? '')
    if (!tabId) { send(401, { message: 'Desktop control is off for this session, or the request is not authorized.' }); return }
    const match = /^\/desktop\/([a-z]+)$/.exec(request.url ?? '')
    if (!match) { send(404, { message: 'Unknown desktop route' }); return }
    if (request.method !== 'POST') { send(405, { message: 'Desktop commands use POST.' }); return }
    if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) { send(415, { message: 'Desktop commands use JSON.' }); return }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY) { send(413, { message: 'Request too large.' }); return }
      chunks.push(chunk as Buffer)
    }
    let body: unknown
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} }
    catch { send(400, { message: 'Invalid JSON.' }); return }
    if (!body || typeof body !== 'object' || Array.isArray(body)) { send(400, { message: 'Invalid request.' }); return }
    try {
      send(200, await this.handle(tabId, match[1]!, body as Record<string, unknown>))
    } catch (error) {
      if (error instanceof DesktopControlError) send(error.status, { message: error.message })
      else {
        this.host.log(`Desktop control failed: ${String(error)}`)
        send(500, { message: error instanceof Error ? error.message : 'Desktop control failed.' })
      }
    }
  }
}

/** Remove a session's state file only while it still holds this token, so a newer one is never removed. */
async function removeStateFile(path: string, token: string): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(path, 'utf8')) as { token?: string }
    if (saved.token === token) await rm(path, { force: true })
  } catch { /* Already removed. */ }
}

/** A request that fails the rules' validation is a refusal (400), not a failure. */
function checked<T>(validate: () => T): T {
  try { return validate() } catch (error) {
    if (error instanceof DesktopControlError) throw error
    throw new DesktopControlError(error instanceof Error ? error.message : String(error))
  }
}
