import { win32 } from 'node:path'

/**
 * The rules desktop control enforces, kept pure so each one is tested on its own. The main process applies them before
 * every capture and every input; the instructions Copilot reads only describe them.
 */

/** Who owns a window: a desktop program by its full path, or a packaged (UWP/MSIX) app by its AppUserModelID. */
export type DesktopAppIdentity =
  | { kind: 'program'; path: string }
  | { kind: 'package'; aumid: string }

export interface DesktopWindowFacts {
  identity: DesktopAppIdentity | null
  className: string
  elevated: boolean | null
}

export type DesktopBlockReason =
  | 'self'
  | 'terminal'
  | 'launcher'
  | 'credentials'
  | 'system'
  | 'elevated'
  | 'unidentified'

export const DESKTOP_BLOCK_MESSAGES: Record<DesktopBlockReason, string> = {
  self: 'Copilot CLI Desktop’s own windows are never controlled, so its approvals stay yours.',
  terminal: 'Terminals and shells are blocked: commands there would get past Copilot CLI’s shell approvals.',
  launcher: 'File Explorer, Start, Search and the Run dialog are blocked: they start programs.',
  credentials: 'Sign-in, credential and password windows are blocked.',
  system: 'System and security settings tools are blocked.',
  elevated: 'Administrator windows are blocked.',
  unidentified: 'This window’s app could not be identified, so it is blocked.',
}

const TERMINALS = new Set([
  'cmd.exe', 'powershell.exe', 'powershell_ise.exe', 'pwsh.exe', 'windowsterminal.exe', 'wt.exe', 'openconsole.exe',
  'conhost.exe', 'bash.exe', 'mintty.exe', 'wsl.exe', 'wslhost.exe', 'git-bash.exe', 'alacritty.exe', 'wezterm-gui.exe',
  'hyper.exe', 'conemu.exe', 'conemu64.exe', 'tabby.exe', 'kitty.exe', 'putty.exe', 'mobaxterm.exe', 'warp.exe',
])
const TERMINAL_CLASSES = new Set(['consolewindowclass', 'cascadia_hosting_window_class', 'pseudoconsolewindow', 'mintty'])
const LAUNCHERS = new Set([
  'explorer.exe', 'startmenuexperiencehost.exe', 'searchhost.exe', 'searchapp.exe', 'searchui.exe', 'shellexperiencehost.exe',
  'shellhost.exe', 'rundll32.exe', 'runonce.exe',
])
const CREDENTIALS = new Set([
  'credentialuibroker.exe', 'consent.exe', 'logonui.exe', 'lockapp.exe', 'securityhealthsystray.exe', 'sechealthui.exe',
  '1password.exe', 'bitwarden.exe', 'keepass.exe', 'keepassxc.exe', 'dashlane.exe', 'enpass.exe', 'lastpass.exe',
  'keeper password manager.exe', 'roboform.exe', 'nordpass.exe', 'proton pass.exe',
])
const SYSTEM = new Set([
  'taskmgr.exe', 'regedit.exe', 'regedt32.exe', 'mmc.exe', 'control.exe', 'systemsettings.exe', 'msconfig.exe',
  'useraccountcontrolsettings.exe', 'systempropertiesadvanced.exe', 'gpedit.exe', 'secpol.exe', 'services.exe',
  'compmgmtlauncher.exe', 'wf.exe', 'netplwiz.exe', 'msiexec.exe',
])
/** Package family names (the AppUserModelID before `!`), lower case. */
const BLOCKED_PACKAGES: Array<[string, DesktopBlockReason]> = [
  ['windows.immersivecontrolpanel_cw5n1h2txyewy', 'system'],
  ['microsoft.windows.sechealthui_cw5n1h2txyewy', 'credentials'],
  ['microsoft.windowsterminal_8wekyb3d8bbwe', 'terminal'],
  ['microsoft.windowsterminalpreview_8wekyb3d8bbwe', 'terminal'],
  ['microsoft.windows.search_cw5n1h2txyewy', 'launcher'],
  ['microsoft.windows.startmenuexperiencehost_cw5n1h2txyewy', 'launcher'],
  ['microsoft.windows.shellexperiencehost_cw5n1h2txyewy', 'launcher'],
  ['microsoft.lockapp_cw5n1h2txyewy', 'credentials'],
  ['microsoft.aad.brokerplugin_cw5n1h2txyewy', 'credentials'],
  ['microsoft.windows.cloudexperiencehost_cw5n1h2txyewy', 'credentials'],
]

/** Apps that can start programs or open files: approving one is allowed, but the prompt warns about it. */
const LAUNCH_CAPABLE = new Set([
  'chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe', 'arc.exe', 'iexplore.exe',
  'winword.exe', 'excel.exe', 'powerpnt.exe', 'outlook.exe', 'onenote.exe', 'msaccess.exe', 'mspub.exe', 'olk.exe',
  'code.exe', 'code - insiders.exe', 'cursor.exe', 'windsurf.exe', 'devenv.exe', 'idea64.exe', 'pycharm64.exe',
  'webstorm64.exe', 'rider64.exe', 'clion64.exe', 'goland64.exe', 'notepad++.exe', 'sublime_text.exe', 'zed.exe',
  'totalcmd.exe', 'totalcmd64.exe', 'everything.exe', 'teams.exe', 'ms-teams.exe', 'slack.exe', 'discord.exe',
])

export function identityKey(identity: DesktopAppIdentity): string {
  return identity.kind === 'program' ? `program:${identity.path.toLowerCase()}` : `package:${identity.aumid.toLowerCase()}`
}

function programName(identity: DesktopAppIdentity): string | null {
  return identity.kind === 'program' ? win32.basename(identity.path).toLowerCase() : null
}

function packageFamily(identity: DesktopAppIdentity): string | null {
  return identity.kind === 'package' ? identity.aumid.split('!', 1)[0]!.toLowerCase() : null
}

/** Why a window may never be captured or controlled, or null when the user may approve it. */
export function desktopBlockReason(facts: DesktopWindowFacts, ownProgramPath: string): DesktopBlockReason | null {
  const { identity } = facts
  if (!identity) return 'unidentified'
  if (identity.kind === 'program' && identity.path.toLowerCase() === ownProgramPath.toLowerCase()) return 'self'
  if (TERMINAL_CLASSES.has(facts.className.toLowerCase())) return 'terminal'
  const program = programName(identity)
  if (program) {
    if (program === 'applicationframehost.exe') return 'unidentified'
    if (TERMINALS.has(program)) return 'terminal'
    if (LAUNCHERS.has(program)) return 'launcher'
    if (CREDENTIALS.has(program)) return 'credentials'
    if (SYSTEM.has(program)) return 'system'
  }
  const family = packageFamily(identity)
  if (family) for (const [blocked, reason] of BLOCKED_PACKAGES) if (family === blocked) return reason
  // Windows refuses input to these anyway (UIPI); an unknown answer is treated as elevated.
  if (facts.elevated !== false) return 'elevated'
  return null
}

export function canStartPrograms(identity: DesktopAppIdentity): boolean {
  const program = programName(identity)
  return program !== null && LAUNCH_CAPABLE.has(program)
}

/** A name for prompts and the log: the program's file name without `.exe`, or the package's app name. */
export function appDisplayName(identity: DesktopAppIdentity): string {
  if (identity.kind === 'program') return win32.basename(identity.path).replace(/\.exe$/i, '')
  const [family = '', app = ''] = identity.aumid.split('!')
  const name = family.split('_', 1)[0]!.split('.').at(-1) || family
  return app && app.toLowerCase() !== 'app' ? `${name} (${app})` : name
}

// Keys

export const DESKTOP_KEY_NAMES: Record<string, number> = {
  enter: 0x0d, return: 0x0d, tab: 0x09, escape: 0x1b, esc: 0x1b, backspace: 0x08, delete: 0x2e, del: 0x2e,
  insert: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  space: 0x20, apps: 0x5d, menu: 0x5d,
}
for (let index = 1; index <= 12; index++) DESKTOP_KEY_NAMES[`f${index}`] = 0x6f + index
for (let code = 0x41; code <= 0x5a; code++) DESKTOP_KEY_NAMES[String.fromCharCode(code + 32)] = code
for (let code = 0x30; code <= 0x39; code++) DESKTOP_KEY_NAMES[String.fromCharCode(code)] = code
const PUNCTUATION: Record<string, number> = { ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde }
Object.assign(DESKTOP_KEY_NAMES, PUNCTUATION)

const MODIFIERS: Record<string, { name: 'ctrl' | 'alt' | 'shift'; vk: number }> = {
  ctrl: { name: 'ctrl', vk: 0x11 }, control: { name: 'ctrl', vk: 0x11 },
  alt: { name: 'alt', vk: 0x12 },
  shift: { name: 'shift', vk: 0x10 },
}

export interface DesktopChord { modifiers: Array<'ctrl' | 'alt' | 'shift'>; key: string; vks: number[] }

/** Chords that open launchers, switch or lock the desktop, or press this app's own global shortcuts. */
const REFUSED_CHORDS = new Set(['ctrl+escape', 'ctrl+shift+escape', 'alt+tab', 'alt+shift+tab', 'alt+escape', 'ctrl+alt+tab', 'ctrl+alt+delete', 'ctrl+alt+end'])

function chordText(modifiers: string[], key: string): string {
  return [...['ctrl', 'alt', 'shift'].filter(name => modifiers.includes(name)), key].join('+')
}

/** Electron accelerators such as `CommandOrControl+Alt+H` as chord text (`ctrl+alt+h`). */
export function acceleratorChord(accelerator: string): string {
  const parts = accelerator.toLowerCase().split('+').map(part => part === 'commandorcontrol' || part === 'cmdorctrl' || part === 'control' ? 'ctrl' : part === 'esc' ? 'escape' : part)
  const key = parts.pop() ?? ''
  return chordText(parts, key)
}

/** Parse a chord such as `ctrl+s` against the fixed list. Win-key chords and the app's own shortcuts are refused. */
export function parseDesktopChord(text: string, reservedAccelerators: string[]): DesktopChord {
  if (typeof text !== 'string' || text.length === 0 || text.length > 40) throw new Error('Give one key or chord, such as enter or ctrl+s.')
  const parts = text.toLowerCase().replaceAll(' ', '').split('+')
  // `ctrl++` means Ctrl and the plus key, which is `=` with Shift on US layouts; keep the chord list simple instead.
  if (parts.some(part => part.length === 0)) throw new Error(`Unknown key chord: ${text}`)
  const keyName = parts.pop()!
  const modifiers: Array<'ctrl' | 'alt' | 'shift'> = []
  for (const part of parts) {
    if (part === 'win' || part === 'windows' || part === 'meta' || part === 'super' || part === 'cmd' || part === 'command') {
      throw new Error('Win-key chords are refused: they open Run, Start, Explorer and other launchers.')
    }
    const modifier = MODIFIERS[part]
    if (!modifier) throw new Error(`Unknown modifier in ${text}: use ctrl, alt or shift.`)
    if (!modifiers.includes(modifier.name)) modifiers.push(modifier.name)
  }
  if (keyName === 'win' || keyName === 'lwin' || keyName === 'rwin' || keyName === 'meta') throw new Error('The Win key is refused.')
  const normalizedKey = keyName === 'esc' ? 'escape' : keyName === 'return' ? 'enter' : keyName === 'del' ? 'delete' : keyName === 'menu' ? 'apps' : keyName
  const vk = DESKTOP_KEY_NAMES[normalizedKey]
  if (vk === undefined) throw new Error(`Unknown key: ${keyName}`)
  const chord = chordText(modifiers, normalizedKey)
  const reserved = new Set(reservedAccelerators.map(acceleratorChord))
  if (REFUSED_CHORDS.has(chord)) throw new Error(`${chord} is refused: it switches, locks or opens parts of Windows.`)
  if (reserved.has(chord)) throw new Error(`${chord} is one of Copilot CLI Desktop’s own shortcuts, so it is refused.`)
  const order: Array<'ctrl' | 'alt' | 'shift'> = ['ctrl', 'alt', 'shift']
  const sorted = order.filter(name => modifiers.includes(name))
  return { modifiers: sorted, key: normalizedKey, vks: [...sorted.map(name => MODIFIERS[name]!.vk), vk] }
}

// Text

export const DESKTOP_TEXT_LIMIT = 4096

/** Text to type: UTF-8, at most 4 KiB, with no control characters other than new lines and tabs (CRLF becomes one Enter). */
export function validateDesktopText(text: unknown): string {
  if (typeof text !== 'string' || text.length === 0) throw new Error('There is no text to type.')
  if (Buffer.byteLength(text, 'utf8') > DESKTOP_TEXT_LIMIT) throw new Error('Text to type is limited to 4 KiB.')
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(normalized)) throw new Error('Text to type may contain new lines and tabs, but no other control characters.')
  return normalized
}

// Frames and coordinates

export interface DesktopRect { x: number; y: number; width: number; height: number }

export interface DesktopFrameGeometry {
  /** The physical screen area the frame shows. */
  bounds: DesktopRect
  /** The frame image's size in pixels. */
  width: number
  height: number
}

export const DESKTOP_FRAME_MAX_SIDE = 1568
export const DESKTOP_FRAME_MAX_AGE_MS = 30_000

/** The image size for a physical area, scaled down to at most 1568 px on the long side and never up. */
export function desktopFrameSize(physical: { width: number; height: number }): { width: number; height: number } {
  const scale = Math.min(1, DESKTOP_FRAME_MAX_SIDE / Math.max(physical.width, physical.height))
  return { width: Math.max(1, Math.round(physical.width * scale)), height: Math.max(1, Math.round(physical.height * scale)) }
}

/** A point in a frame's pixels as physical screen pixels, or an error when it is outside the frame. */
export function framePointToScreen(frame: DesktopFrameGeometry, x: unknown, y: unknown): { x: number; y: number } {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Give the point as x and y numbers in the screenshot’s pixels.')
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) throw new Error(`The point is outside the screenshot (${frame.width}×${frame.height}).`)
  return {
    x: frame.bounds.x + Math.floor((x + 0.5) * frame.bounds.width / frame.width),
    y: frame.bounds.y + Math.floor((y + 0.5) * frame.bounds.height / frame.height),
  }
}

export function rectContains(rect: DesktopRect, point: { x: number; y: number }): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height
}

export function sameRect(a: DesktopRect, b: DesktopRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

export function intersectRect(a: DesktopRect, b: DesktopRect): DesktopRect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
}

export const DESKTOP_PATCH_SIZE = 64

/** The square patch (in frame pixels) centred on a point, clipped to the frame. */
export function patchRect(frame: { width: number; height: number }, x: number, y: number, size = DESKTOP_PATCH_SIZE): DesktopRect {
  const half = Math.floor(size / 2)
  const left = Math.max(0, Math.min(frame.width - 1, Math.round(x) - half))
  const top = Math.max(0, Math.min(frame.height - 1, Math.round(y) - half))
  return { x: left, y: top, width: Math.min(size, frame.width - left), height: Math.min(size, frame.height - top) }
}

/**
 * Whether two 4-byte-per-pixel images match inside a patch. A text caret or a hover tint changes a few pixels; a dialog,
 * a sheet or a moved control changes many. Both images use the same channel order, so any order works.
 */
export function patchesMatch(
  before: Buffer, after: Buffer, size: { width: number; height: number }, patch: DesktopRect,
  { threshold = 48, maxChangedFraction = 0.03 } = {},
): boolean {
  if (before.length !== size.width * size.height * 4 || after.length !== before.length) return false
  let changed = 0
  for (let y = patch.y; y < patch.y + patch.height; y++) {
    for (let x = patch.x; x < patch.x + patch.width; x++) {
      const offset = (y * size.width + x) * 4
      const difference = Math.max(
        Math.abs(before[offset]! - after[offset]!),
        Math.abs(before[offset + 1]! - after[offset + 1]!),
        Math.abs(before[offset + 2]! - after[offset + 2]!),
      )
      if (difference > threshold) changed++
    }
  }
  return changed <= patch.width * patch.height * maxChangedFraction
}

/** Paint rectangles (in image pixels) opaque dark grey in a 4-byte-per-pixel image. */
export function blankRects(bitmap: Buffer, size: { width: number; height: number }, rects: DesktopRect[]): void {
  for (const rect of rects) {
    const clipped = intersectRect(rect, { x: 0, y: 0, width: size.width, height: size.height })
    if (!clipped) continue
    for (let y = clipped.y; y < clipped.y + clipped.height; y++) {
      for (let x = clipped.x; x < clipped.x + clipped.width; x++) {
        const offset = (y * size.width + x) * 4
        bitmap[offset] = 17; bitmap[offset + 1] = 17; bitmap[offset + 2] = 17; bitmap[offset + 3] = 255
      }
    }
  }
}

/** A physical screen rectangle as image pixels of a frame, rounded outwards so blanking never leaves an edge visible. */
export function screenRectToFrame(frame: DesktopFrameGeometry, rect: DesktopRect): DesktopRect {
  const sx = frame.width / frame.bounds.width
  const sy = frame.height / frame.bounds.height
  const left = Math.floor((rect.x - frame.bounds.x) * sx)
  const top = Math.floor((rect.y - frame.bounds.y) * sy)
  const right = Math.ceil((rect.x + rect.width - frame.bounds.x) * sx)
  const bottom = Math.ceil((rect.y + rect.height - frame.bounds.y) * sy)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

// Limits

/** At most `perSecond` actions in any one-second window. */
export class DesktopRateLimiter {
  private readonly times: number[] = []
  constructor(private readonly perSecond = 10, private readonly now: () => number = Date.now) {}
  take(): boolean {
    const now = this.now()
    while (this.times.length && now - this.times[0]! >= 1000) this.times.shift()
    if (this.times.length >= this.perSecond) return false
    this.times.push(now)
    return true
  }
}

export function isWindowId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)
}

export function isFrameId(value: unknown): value is string {
  return typeof value === 'string' && /^f[0-9a-f]{12}$/.test(value)
}
