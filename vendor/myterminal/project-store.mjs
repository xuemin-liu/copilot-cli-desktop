import { createSessionStore } from './src/store/useSessionStore.js'

const projects = new Map()
export function projectTerminal(profileId) {
  if (projects.has(profileId)) return projects.get(profileId)
  const call = (method, ...args) => window.copilotDesktop.myTerminal(profileId, method, args)
  const api = {}
  const groups = {
    sessions: ['getAll', 'save', 'delete', 'import', 'export', 'duplicate'], settings: ['get', 'set'],
    snippets: ['getAll', 'save', 'delete'], backup: ['import', 'export'], favorites: ['get', 'set'],
    filterPresets: ['getAll', 'save', 'delete'], logging: ['start', 'stop', 'status', 'export'],
    sftp: ['list', 'download', 'upload', 'uploadDir', 'downloadDir', 'rename', 'delete', 'mkdir', 'realpath', 'readFile', 'writeFile'],
    tunnel: ['start', 'stop', 'stopByChannel', 'list'], dialog: ['openFile', 'saveFile'], fs: ['isDirectory'],
  }
  for (const [group, methods] of Object.entries(groups)) api[group] = Object.fromEntries(methods.map(method => [method, (...args) => call(`${group}:${method}`, ...args)]))
  api.sshconfig = { import: () => call('sshconfig:import') }
  api.wsl = { getDistros: () => call('wsl:getDistros') }
  api.tunnel.getConfigs = id => call('tunnelConfigs:get', id)
  api.tunnel.setConfigs = (id, configs) => call('tunnelConfigs:set', id, configs)
  api.logging.write = () => {} // Main process records output, including hidden tabs.
  api.getDropPaths = () => window.copilotDesktop.myTerminalDrop(profileId)
  const store = createSessionStore(api, false)
  store.setState({
    openTab: async config => {
      return call('sessions:connectTemporary', config, store.getState().activeTabId)
    },
    addSplitPane: tabId => window.copilotDesktop.toolTerminal(profileId, { action: 'split', id: tabId }),
    removeSplitPane: tabId => window.copilotDesktop.toolTerminal(profileId, { action: 'unsplit', id: tabId }),
  })
  let pending
  const result = { api, store, load() {
    if (!pending) pending = store.getState().loadSessions().finally(() => { pending = undefined })
    return pending
  }, importSshConfig: () => call('sshconfig:import') }
  projects.set(profileId, result)
  return result
}
