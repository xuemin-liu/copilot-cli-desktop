import type { Terminal } from '@xterm/xterm'
import type { TerminalSnapshot } from '../main/tool-terminal.js'
import { isMac, isWindows } from './platform.js'
import { projectTerminal } from '../../vendor/myterminal/project-store.mjs'

export type Snapshot = Omit<TerminalSnapshot, 'status'> & { status: TerminalSnapshot['status'] | 'disconnected'; reconnectCountdown?: number | null; reconnectExhausted?: boolean }
type Listener = (id: string, value: string) => void

/** Translate the project-scoped bridge to MyTerminal's transport contract.
 * Terminal input, paste, focus, filtering and reconnect remain in MyTerminal. */
export function createMyTerminalHost(profileId: string, id: string, changed: (state: Snapshot) => void, failed: (message: string) => void) {
  let active = false, stopped = false, cursor = 0, generation = '', status = '', connecting = false
  let epoch = 0, initialized = false
  const reconnectAttempts = { current: 0 }
  let timer: ReturnType<typeof setTimeout> | undefined
  let unsubscribeOutput: (() => void) | undefined
  const revisions = new Map<string, number>()
  const pendingOutput = new Map<string, Snapshot[]>()
  let terminal: Terminal | null = null
  const project = typeof window.copilotDesktop.myTerminal === 'function' ? projectTerminal(profileId) : null
  const children = new Map<string, { cursor: number; generation: string; status: string; initialized: boolean }>()
  const listeners = { data: new Set<Listener>(), close: new Set<Listener>(), error: new Set<Listener>(), ready: new Set<Listener>() }
  const call = (request: Record<string, unknown>, channel = id): Promise<unknown> => window.copilotDesktop.toolTerminal(profileId, { ...request, id: channel })
  const report = (error: unknown): void => { if (!stopped) failed(error instanceof Error ? error.message : String(error)) }
  const subscribe = (event: keyof typeof listeners) => (listener: Listener) => { listeners[event].add(listener); return () => listeners[event].delete(listener) }
  const emit = (event: keyof typeof listeners, value = '', channel = id): void => { for (const listener of listeners[event]) listener(channel, value) }
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
  // Reuse MyTerminal's onData path for every live pane, including hidden projects.
  // Cursors deduplicate the initial replay and any poll racing a pushed chunk.
  const consume = (next: Snapshot, channel = id): void => {
    const prior = channel === id ? { cursor, generation, status } : children.get(channel)
    if (!prior || (channel === id && !terminal)) return
    const becameReady = next.status === 'running' && (next.generation !== prior.generation || prior.status !== 'running')
    if (next.generation !== prior.generation) {
      if (prior.generation) emit('data', '\r\n[Reconnected]\r\n', channel)
      prior.generation = next.generation; prior.cursor = 0
    }
    if (next.cursor > prior.cursor) {
      if (next.start > prior.cursor) emit('data', '\r\n[Older terminal output was discarded]\r\n', channel)
      emit('data', next.output.slice(Math.max(0, prior.cursor - next.start)), channel)
      prior.cursor = next.cursor
    }
    if (next.status !== prior.status && next.status === 'exited') emit('close', '', channel)
    if (next.status !== prior.status && next.status === 'error') emit('error', next.error ?? 'Terminal failed', channel)
    prior.status = next.status
    if (channel === id) { cursor = prior.cursor; generation = prior.generation; status = prior.status }
    if (becameReady) emit('ready', '', channel)
  }
  const replay = (next: Snapshot, channel = id): void => {
    if (channel === id && !terminal) return
    const child = children.get(channel)
    if (channel === id ? initialized : child?.initialized) { consume(next, channel); return }
    // Establish a current snapshot before advancing the cursor with live output.
    // Merge overlap by absolute cursor; queued chunks can extend beyond the bounded replay.
    const queued = pendingOutput.get(channel) ?? []
    pendingOutput.delete(channel)
    for (const frame of [...queued.filter(frame => frame.generation === next.generation), next].sort((a, b) => a.start - b.start)) consume({ ...frame, status: next.status, ...(next.error ? { error: next.error } : {}) }, channel)
    if (channel === id) initialized = true
    else if (child) child.initialized = true
  }
  const poll = async (): Promise<void> => {
    try {
      if (connecting || stopped) return
      const revision = revisions.get(id)
      const next = await call({ action: 'read', cursor, generation }) as Snapshot
      if (stopped) return
      if (revision === revisions.get(id)) {
        changed(next)
        replay(next)
      }
      for (const [channel, prior] of children) {
        const childRevision = revisions.get(channel)
        let child: Snapshot
        try { child = await call({ action: 'read', cursor: prior.cursor, generation: prior.generation }, channel) as Snapshot }
        catch (error) {
          const latest = await call({ action: 'read' }) as Snapshot
          if (latest.splitId !== channel) { children.delete(channel); continue }
          throw error
        }
        if (stopped || !children.has(channel)) return
        if (childRevision === revisions.get(channel)) replay(child, channel)
      }
    } catch (error) { if (!stopped && active) report(error) }
    finally { if (!stopped) timer = setTimeout(() => { void poll() }, 200) }
  }
  const send = (request: Record<string, unknown>, channel = id): void => {
    if (!active && request.action !== 'resize') return
    const requestEpoch = epoch
    void call(request, channel).catch(error => {
      if (!active || requestEpoch !== epoch) return
      if (channel === id) report(error)
      else if (children.has(channel)) emit('error', String(error), channel)
    })
  }
  const write = (channel: string, text: string): void => send({ action: 'write', text }, channel)
  const resize = (channel: string, cols: number, rows: number): void => {
    const channelStatus = channel === id ? status : children.get(channel)?.status
    if (channelStatus === 'running') send({ action: 'resize', cols, rows }, channel)
  }
  // Detaching a view does not close a project-owned process. Closing its tab does.
  const disconnect = (channel?: string): void => {
    if (channel && channel !== id) {
      children.delete(channel); pendingOutput.delete(channel)
      revisions.set(id, (revisions.get(id) ?? 0) + 1)
    }
  }
  const attach = async (channel = id): Promise<{ error?: string }> => {
    const requestEpoch = epoch
    // View attachment survives hide/show. Authority for each poll is still checked independently.
    const child = channel === id ? undefined : { cursor: 0, generation: '', status: '', initialized: false }
    if (child) {
      children.set(channel, child)
      // A parent read captured before this attachment cannot remove the new pane from React.
      revisions.set(id, (revisions.get(id) ?? 0) + 1)
    }
    try {
      const state = await call({ action: 'read' }, channel) as Snapshot
      if (stopped) return {}
      if (child && children.get(channel) === child) child.status = state.status
      return !['running', 'starting'].includes(state.status) ? { error: state.error ?? `Terminal ${state.status}` } : {}
    } catch (error) { if (requestEpoch !== epoch || !active) return {}; report(error); return { error: String(error) } }
  }
  const presetKey = 'myterminal.filter-presets'
  const presets = (): Record<string, unknown>[] => {
    try { const value: unknown = JSON.parse(localStorage.getItem(presetKey) ?? '[]'); return Array.isArray(value) ? value.slice(0, 10) : [] } catch { return [] }
  }
  const savePresets = (value: Record<string, unknown>[]): Record<string, unknown>[] => { localStorage.setItem(presetKey, JSON.stringify(value)); return value }
  const storeState = { settings: { defaultFontSize: 14, defaultScrollback: 10000, colorizeByDefault: true, osc52ClipboardEnabled: false, loggingEnabled: false }, broadcastMode: false, tabs: [] }
  const store = project?.store ?? Object.assign(() => storeState, { getState: () => storeState })
  const api = {
    platform: isWindows ? 'win32' : isMac ? 'darwin' : 'linux',
    local: { spawn: attach, write, resize, disconnect },
    ssh: { connect: attach, write, resize, disconnect, onData: subscribe('data'), onClose: subscribe('close'), onError: subscribe('error'), onReady: subscribe('ready'), ping: (channel: string) => window.copilotDesktop.myTerminal(profileId, 'ssh:ping', [channel]) },
    clipboard: { writeText: (text: string) => window.copilotDesktop.copyText(text), readText: () => window.copilotDesktop.readClipboardText() },
    filterPresets: { getAll: async () => presets(), save: async (preset: Record<string, unknown>) => savePresets([...presets().filter(p => p.id !== preset.id), preset].slice(-10)), delete: async (key: string) => savePresets(presets().filter(p => p.id !== key)) },
    tunnel: { stopByChannel: disconnect },
    notify: { send: (title: string, body: string) => { if (Notification.permission === 'granted') new Notification(title, { body }) } },
    ...project?.api,
  }
  if (project) api.tunnel = { ...project.api.tunnel,
    start: (channel: string, key: string, config: object) => project.api.tunnel.start(channel, `${channel}-${key}`, config),
    stop: (key: string) => project.api.tunnel.stop(`${id}-${key}`),
    list: async () => (await project.api.tunnel.list()).filter((item: { channelId: string }) => item.channelId === id).map((item: { id: string }) => ({ ...item, id: item.id.slice(id.length + 1) })),
    stopByChannel: disconnect,
  }
  return { api, store, openExternal: (url: string) => { void window.copilotDesktop.openExternalUrl(url).catch(report) }, backgroundLifecycle: true, cancelReconnect: () => send({ action: 'cancel-reconnect' }), broadcast: (text: string) => send({ action: 'broadcast', text }), reconnectAttempts, features: Boolean(project), backgroundLogging: Boolean(project), isActive: () => active, onTerminal: (term: Terminal | null) => { terminal = term }, getTerminal: () => terminal,
    setActive(value: boolean) { if (active !== value) { epoch++; if (value) void project?.load().catch(report) }; active = value }, connect,
    start() {
      stopped = false
      unsubscribeOutput = window.copilotDesktop.onToolTerminalOutput?.((profile, next) => {
        if (stopped || profile !== profileId || (next.id !== id && !children.has(next.id))) return
        revisions.set(next.id, (revisions.get(next.id) ?? 0) + 1)
        if (next.id === id ? !initialized : !children.get(next.id)?.initialized) {
          if (next.id === id && !terminal) changed(next)
          const queued = pendingOutput.get(next.id) ?? []; queued.push(next); pendingOutput.set(next.id, queued)
        } else consume(next, next.id)
      })
      void poll()
    },
    stop() { stopped = true; unsubscribeOutput?.(); pendingOutput.clear(); if (timer) clearTimeout(timer) },
  }
}
