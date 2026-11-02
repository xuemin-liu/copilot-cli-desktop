import { Worker } from 'node:worker_threads'
import type { DesktopNativeFocus, DesktopNativeRequest, DesktopNativeWindow } from './desktop-native-types.js'

/** The operations desktop control needs from the OS. Tests replace it with a fake. */
export interface DesktopNativeLayer {
  windows(): Promise<DesktopNativeWindow[]>
  foreground(): Promise<string | null>
  focus(id: string): Promise<boolean>
  cursor(): Promise<{ x: number; y: number }>
  move(x: number, y: number): Promise<void>
  click(x: number, y: number, button: 'left' | 'right' | 'middle', count: number): Promise<void>
  drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void>
  scroll(x: number, y: number, dx: number, dy: number): Promise<void>
  key(vks: number[]): Promise<void>
  type(text: string): Promise<void>
  focused(): Promise<DesktopNativeFocus>
  desktopAvailable(): Promise<boolean>
  dispose(): Promise<void>
}

const TIMEOUT_MS = 5_000

/** Runs the Win32 calls in a worker; a call that hangs (a frozen app, UI Automation) is abandoned and the worker replaced. */
export class WindowsDesktopNative implements DesktopNativeLayer {
  private worker: Worker | null = null
  private sequence = 0
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()

  private spawn(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./desktop-native-worker.js', import.meta.url))
    worker.unref()
    worker.on('message', (message: { id: number; ok: boolean; value?: unknown; error?: string }) => {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.ok) entry.resolve(message.value)
      else entry.reject(new Error(message.error ?? 'Desktop control failed.'))
    })
    const fail = (error: Error): void => {
      if (this.worker !== worker) return
      this.worker = null
      for (const [id, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(error); this.pending.delete(id) }
    }
    worker.on('error', error => fail(error instanceof Error ? error : new Error(String(error))))
    worker.on('exit', () => fail(new Error('Desktop control’s native helper stopped.')))
    this.worker = worker
    return worker
  }

  private request<T>(request: DesktopNativeRequest, timeoutMs = TIMEOUT_MS): Promise<T> {
    const worker = this.spawn()
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // The call may still be stuck inside Windows; a fresh worker answers the next request.
        if (this.worker === worker) { this.worker = null; void worker.terminate() }
        reject(new Error('Windows did not answer in time; the action was not confirmed.'))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      worker.postMessage({ id, request })
    })
  }

  windows(): Promise<DesktopNativeWindow[]> { return this.request({ op: 'windows' }) }
  foreground(): Promise<string | null> { return this.request({ op: 'foreground' }) }
  focus(id: string): Promise<boolean> { return this.request({ op: 'focus', id }) }
  cursor(): Promise<{ x: number; y: number }> { return this.request({ op: 'cursor' }) }
  move(x: number, y: number): Promise<void> { return this.request({ op: 'move', x, y }) }
  click(x: number, y: number, button: 'left' | 'right' | 'middle', count: number): Promise<void> { return this.request({ op: 'click', x, y, button, count }) }
  drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> { return this.request({ op: 'drag', from, to }) }
  scroll(x: number, y: number, dx: number, dy: number): Promise<void> { return this.request({ op: 'scroll', x, y, dx, dy }) }
  key(vks: number[]): Promise<void> { return this.request({ op: 'key', vks }) }
  type(text: string): Promise<void> { return this.request({ op: 'type', text }) }
  focused(): Promise<DesktopNativeFocus> { return this.request({ op: 'focused' }, 3_000) }
  desktopAvailable(): Promise<boolean> { return this.request({ op: 'desktop' }) }

  async dispose(): Promise<void> {
    const worker = this.worker
    this.worker = null
    for (const [id, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(new Error('Desktop control stopped.')); this.pending.delete(id) }
    if (worker) await worker.terminate()
  }
}

/** Counts the user's own mouse and keyboard input while desktop control is on. */
export interface DesktopInputMonitor {
  start(): Promise<void>
  stop(): Promise<void>
  /** How many user inputs have been seen, and when the last one was (ms since the epoch, 0 when none). */
  read(): { count: number; lastAt: number }
}

export class WindowsDesktopInputMonitor implements DesktopInputMonitor {
  private worker: Worker | null = null
  private readonly shared = new Float64Array(new SharedArrayBuffer(16))

  async start(): Promise<void> {
    if (this.worker) return
    const worker = new Worker(new URL('./desktop-input-monitor-worker.js', import.meta.url), { workerData: { shared: this.shared.buffer } })
    worker.unref()
    this.worker = worker
    worker.on('exit', () => { if (this.worker === worker) this.worker = null })
    const ready = await new Promise<boolean>(resolve => {
      worker.once('message', (message: { ready?: boolean }) => resolve(message.ready === true))
      worker.once('error', () => resolve(false))
    })
    if (!ready) {
      await this.stop()
      throw new Error('Desktop control could not watch for your own mouse and keyboard input, so it stays off.')
    }
  }

  async stop(): Promise<void> {
    const worker = this.worker
    this.worker = null
    if (!worker) return
    worker.postMessage('stop')
    await Promise.race([new Promise(resolve => worker.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 500))])
    await worker.terminate()
  }

  read(): { count: number; lastAt: number } {
    return { count: this.shared[0]!, lastAt: this.shared[1]! }
  }
}
