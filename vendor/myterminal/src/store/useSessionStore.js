import { create } from 'zustand'

const SENSITIVE_CONFIG_FIELDS = ['password', 'passphrase', 'jumpPassword', 'jumpPassphrase']

function stripSensitiveConfig(config) {
  if (!config || typeof config !== 'object') return config
  const safeConfig = { ...config }
  for (const field of SENSITIVE_CONFIG_FIELDS) delete safeConfig[field]
  return safeConfig
}

const useSessionStore = create((set, get) => ({
  sessions: [],
  tabs: [],
  activeTabId: null,
  snippets: [],
  broadcastMode: false,
  settings: {
    defaultFontSize: 14,
    defaultScrollback: 10000,
    colorizeByDefault: true,
    osc52ClipboardEnabled: false,
    keepaliveInterval: 10000,
    loggingEnabled: false,
    logDirectory: '',
  },

  // ── Workspace persistence ────────────────────────────────────────────────────

  saveWorkspace: () => {
    const { tabs, activeTabId } = get()
    // Only persist the serializable tab descriptors (no live state)
    const serializedTabs = tabs.map(({ id, sessionId, label, config, channelId, color, isLocal, wslDistro }) => ({
      id, sessionId, label, config: stripSensitiveConfig(config), channelId, color, isLocal, wslDistro,
    }))
    window.electronAPI.workspace.set({ tabs: serializedTabs, activeTabId })
  },

  loadWorkspace: async () => {
    const ws = await window.electronAPI.workspace.get()
    if (!ws || !Array.isArray(ws.tabs) || ws.tabs.length === 0) return
    const { sessions } = get()
    // Restore tabs with full shape (fill in defaults for split pane fields)
    const tabs = ws.tabs.map((t) => ({
      ...t,
      config: t.sessionId
        ? (sessions.find((s) => s.id === t.sessionId) || stripSensitiveConfig(t.config))
        : stripSensitiveConfig(t.config),
      splitChannelId: null,
      splitConfig: null,
    }))
    set({ tabs, activeTabId: ws.activeTabId || tabs[0]?.id || null })
  },

  // ── Session actions ──────────────────────────────────────────────────────────

  loadSessions: async () => {
    const sessions = await window.electronAPI.sessions.getAll()
    const snippets = await window.electronAPI.snippets.getAll()
    const settings = await window.electronAPI.settings.get()
    set({ sessions, snippets, settings })
  },

  addSession: async (session) => {
    const saved = await window.electronAPI.sessions.save(session)
    set({ sessions: saved })
  },

  updateSession: async (session) => {
    const saved = await window.electronAPI.sessions.save(session)
    set({ sessions: saved })
  },

  deleteSession: async (id) => {
    const saved = await window.electronAPI.sessions.delete(id)
    set({ sessions: saved })
  },

  exportSessions: async () => {
    const { sessions } = get()
    return await window.electronAPI.sessions.export(sessions)
  },

  importSessions: async () => {
    const result = await window.electronAPI.sessions.import()
    if (Array.isArray(result)) set({ sessions: result })
    return result
  },

  exportBackup: async (options) => {
    return await window.electronAPI.backup.export(options)
  },

  importBackup: async () => {
    const result = await window.electronAPI.backup.import()
    if (result?.success) {
      // Refresh sessions / snippets / settings so the UI reflects merged data.
      // SFTP favorites, filter presets and tunnel configs load lazily per-panel
      // and will pick up the new data the next time their owning panel mounts.
      await get().loadSessions()
    }
    return result
  },

  // ── Snippet actions ──────────────────────────────────────────────────────────

  addSnippet: async (snippet) => {
    const saved = await window.electronAPI.snippets.save({
      ...snippet,
      id: snippet.id || crypto.randomUUID(),
    })
    set({ snippets: saved })
  },

  deleteSnippet: async (id) => {
    const saved = await window.electronAPI.snippets.delete(id)
    set({ snippets: saved })
  },

  // ── Settings ────────────────────────────────────────────────────────────────

  updateSettings: async (patch) => {
    const saved = await window.electronAPI.settings.set(patch)
    set({ settings: saved })
  },

  // ── Broadcast ────────────────────────────────────────────────────────────────

  toggleBroadcast: () => set((state) => ({ broadcastMode: !state.broadcastMode })),

  // ── Tab actions ──────────────────────────────────────────────────────────────

  openTab: (session) => {
    const id = crypto.randomUUID()
    const tab = {
      id,
      sessionId: session.id,
      label: session.name || `${session.username}@${session.host}${session.port && session.port !== 22 ? ':' + session.port : ''}`,
      config: { ...session },
      channelId: id,
      color: null,
      splitChannelId: null,
      splitConfig: null,
      isLocal: false,
    }
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: id }))
    return tab
  },

  openQuickConnectTab: (config) => {
    const id = crypto.randomUUID()
    const tab = {
      id,
      sessionId: null,
      label: `${config.username}@${config.host}${config.port && config.port !== 22 ? ':' + config.port : ''}`,
      config,
      channelId: id,
      color: null,
      splitChannelId: null,
      splitConfig: null,
      isLocal: false,
    }
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: id }))
    return tab
  },

  openLocalTab: () => {
    const id = crypto.randomUUID()
    const tab = {
      id,
      sessionId: null,
      label: 'Local Terminal',
      config: null,
      channelId: id,
      color: null,
      splitChannelId: null,
      splitConfig: null,
      isLocal: true,
      wslDistro: null,
    }
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: id }))
    return tab
  },

  openWslTab: (distro) => {
    const id = crypto.randomUUID()
    const tab = {
      id,
      sessionId: null,
      label: distro ? `WSL: ${distro}` : 'WSL',
      config: null,
      channelId: id,
      color: null,
      splitChannelId: null,
      splitConfig: null,
      isLocal: true,
      wslDistro: distro || null,
    }
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: id }))
    return tab
  },

  closeTab: (tabId) => {
    set((state) => {
      const tabs = state.tabs.filter((t) => t.id !== tabId)
      let activeTabId = state.activeTabId
      if (activeTabId === tabId) {
        const idx = state.tabs.findIndex((t) => t.id === tabId)
        activeTabId = tabs.length === 0 ? null : tabs[Math.min(idx, tabs.length - 1)].id
      }
      return { tabs, activeTabId }
    })
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  updateTab: (tabId, patch) => set((state) => ({
    tabs: state.tabs.map((t) => t.id === tabId ? { ...t, ...patch } : t),
  })),

  reorderTabs: (fromIndex, toIndex) => set((state) => {
    const tabs = [...state.tabs]
    const [moved] = tabs.splice(fromIndex, 1)
    tabs.splice(toIndex, 0, moved)
    return { tabs }
  }),

  addSplitPane: (tabId) => {
    const id = crypto.randomUUID()
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, splitChannelId: id, splitConfig: { ...t.config } } : t
      ),
    }))
    return id
  },

  removeSplitPane: (tabId) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, splitChannelId: null, splitConfig: null } : t
      ),
    }))
  },
}))

// Auto-save workspace when tabs or activeTabId change
let prevTabs = null
let prevActiveTabId = null
useSessionStore.subscribe((state) => {
  if (state.tabs !== prevTabs || state.activeTabId !== prevActiveTabId) {
    prevTabs = state.tabs
    prevActiveTabId = state.activeTabId
    state.saveWorkspace()
  }
})

export default useSessionStore
