import type { Terminal } from '@xterm/xterm'
import type { TerminalSnapshot } from '../main/tool-terminal.js'
import { isMac, isWindows } from './platform.js'

export type Snapshot = Omit<TerminalSnapshot, 'status'> & { status: TerminalSnapshot['status'] | 'disconnected' }
type Listener = (id: string, value: string) => void

/** Translate the project-scoped bridge to MyTerminal's transport contract.
 * Terminal input, paste, focus, filtering and reconnect remain in MyTerminal. */
export function createMyTerminalHost(profileId: string, id: string, changed: (state: Snapshot) => void, failed: (message: string) => void) {
  let active = false, stopped = false, cursor = 0, generation = '', status = '', connecting = false
  let epoch = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let terminal: Terminal | null = null
  const listeners = { data: new Set<Listener>(), close: new Set<Listener>(), error: new Set<Listener>() }
  const call = (request: Record<string, unknown>): Promise<unknown> => window.copilotDesktop.toolTerminal(profileId, { ...request, id })
  const report = (error: unknown): void => { if (!stopped) failed(error instanceof Error ? error.message : String(error)) }
  const subscribe = (event: keyof typeof listeners) => (listener: Listener) => { listeners[event].add(listener); return () => listeners[event].delete(listener) }
  const emit = (event: keyof typeof listeners, value = ''): void => { for (const listener of listeners[event]) listener(id, value) }
  const connect = async (): Promise<{ error?: string }> => {
    if (connecting || stopped || !active) return {}
    const requestEpoch = epoch
    connecting = true
    try {
      const state = await call({ action: 'read' }) as Snapshot
      if (stopped || !active || requestEpoch !== epoch) return {}
      if (state.status !== 'running' && state.status !== 'starting') {
        const started = await call({ action: state.status === 'disconnected' ? 'start' : 'restart' }) as Snapshot
        if (stopped || !active || requestEpoch !== epoch) return {}
        if (started.status === 'error') return { error: started.error ?? 'Terminal failed' }
      }
      return {}
    } catch (error) {
      if (stopped || !active || requestEpoch !== epoch) return {}
      report(error); return { error: error instanceof Error ? error.message : String(error) }
    }
    finally { connecting = false }
  }
  const poll = async (): Promise<void> => {
    const requestEpoch = epoch
    try {
      if (!active || connecting || stopped) return
      const next = await call({ action: 'read', cursor, generation }) as Snapshot
      if (stopped || !active || requestEpoch !== epoch) return
      changed(next)
      // Let React attach the view for a new process before replaying its output.
      if (next.generation !== generation) { generation = next.generation; cursor = 0; status = next.status; return }
      if (next.start > cursor) { terminal?.reset(); terminal?.writeln('[Older terminal output was discarded]') }
      if (next.output) emit('data', next.output)
      cursor = next.cursor
      if (next.status !== status && next.status === 'exited') emit('close')
      if (next.status !== status && next.status === 'error') emit('error', next.error ?? 'Terminal failed')
      status = next.status
    } catch (error) { if (active && requestEpoch === epoch) report(error) }
    finally { if (!stopped) timer = setTimeout(() => { void poll() }, 200) }
  }
  const send = (request: Record<string, unknown>): void => {
    if (!active) return
    const requestEpoch = epoch
    void call(request).catch(error => { if (active && requestEpoch === epoch) report(error) })
  }
  const write = (_channel: string, text: string): void => send({ action: 'write', text })
  const resize = (_channel: string, cols: number, rows: number): void => {
    if (status === 'running') send({ action: 'resize', cols, rows })
  }
  // Detaching a view does not close a project-owned process. Closing its tab does.
  const disconnect = (): void => {}
  const attach = async (): Promise<{ error?: string }> => {
    const requestEpoch = epoch
    try {
      const state = await call({ action: 'read' }) as Snapshot
      if (stopped || !active || requestEpoch !== epoch) return {}
      return !['running', 'starting'].includes(state.status) ? { error: state.error ?? `Terminal ${state.status}` } : {}
    } catch (error) { if (requestEpoch !== epoch || !active) return {}; report(error); return { error: String(error) } }
  }
  const presetKey = 'myterminal.filter-presets'
  const presets = (): Record<string, unknown>[] => {
    try { const value: unknown = JSON.parse(localStorage.getItem(presetKey) ?? '[]'); return Array.isArray(value) ? value.slice(0, 10) : [] } catch { return [] }
  }
  const savePresets = (value: Record<string, unknown>[]): Record<string, unknown>[] => { localStorage.setItem(presetKey, JSON.stringify(value)); return value }
  const storeState = { settings: { defaultFontSize: 14, defaultScrollback: 10000, colorizeByDefault: true, osc52ClipboardEnabled: false, loggingEnabled: false }, broadcastMode: false, tabs: [] }
  const store = Object.assign(() => storeState, { getState: () => storeState })
  const api = {
    platform: isWindows ? 'win32' : isMac ? 'darwin' : 'linux',
    local: { spawn: attach, write, resize, disconnect },
    ssh: { connect: attach, write, resize, disconnect, onData: subscribe('data'), onClose: subscribe('close'), onError: subscribe('error') },
    clipboard: { writeText: (text: string) => navigator.clipboard.writeText(text) },
    filterPresets: { getAll: async () => presets(), save: async (preset: Record<string, unknown>) => savePresets([...presets().filter(p => p.id !== preset.id), preset].slice(-10)), delete: async (key: string) => savePresets(presets().filter(p => p.id !== key)) },
    tunnel: { stopByChannel: disconnect },
    notify: { send: (title: string, body: string) => { if (Notification.permission === 'granted') new Notification(title, { body }) } },
  }
  return { api, store, isActive: () => active, onTerminal: (term: Terminal | null) => { terminal = term }, getTerminal: () => terminal,
    setActive(value: boolean) { if (active !== value) epoch++; active = value }, connect,
    start() { stopped = false; void poll() },
    stop() { stopped = true; if (timer) clearTimeout(timer) },
  }
}
