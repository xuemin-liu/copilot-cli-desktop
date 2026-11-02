import type { DesktopRect } from './desktop-control-rules.js'

/** A visible top-level window, in z-order (front first), as the native layer reports it. Bounds are physical pixels. */
export interface DesktopNativeWindow {
  id: string
  pid: number
  title: string
  className: string
  bounds: DesktopRect
  minimized: boolean
  /** Input passes through it (layered and transparent), as for the app's own on-screen banner. */
  clickThrough: boolean
  toolWindow: boolean
  owner: string | null
  /** A desktop program's full path; null for a packaged app or when it could not be read. */
  programPath: string | null
  /** A packaged app's AppUserModelID, read from the process behind ApplicationFrameHost. */
  aumid: string | null
  elevated: boolean | null
}

export interface DesktopNativeFocus { pid: number | null; password: boolean | null }

export type DesktopNativeRequest =
  | { op: 'windows' }
  | { op: 'foreground' }
  | { op: 'focus'; id: string }
  | { op: 'cursor' }
  | { op: 'move'; x: number; y: number }
  | { op: 'click'; x: number; y: number; button: 'left' | 'right' | 'middle'; count: number }
  | { op: 'drag'; from: { x: number; y: number }; to: { x: number; y: number } }
  | { op: 'scroll'; x: number; y: number; dx: number; dy: number }
  | { op: 'key'; vks: number[] }
  | { op: 'type'; text: string }
  | { op: 'focused' }
  | { op: 'desktop' }
