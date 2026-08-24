const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('copilotDesktop', {
  getState: () => ipcRenderer.invoke('desktop:get-state'),
  selectWorkspace: () => ipcRenderer.invoke('desktop:select-workspace'),
  activateProfile: (profileId) => ipcRenderer.invoke('desktop:activate-profile', profileId),
  createTab: (resumeMode) => ipcRenderer.invoke('desktop:create-tab', resumeMode ?? null),
  activateTab: (tabId) => ipcRenderer.invoke('desktop:activate-tab', tabId),
  closeTab: (tabId) => ipcRenderer.invoke('desktop:close-tab', tabId),
  restartTab: (tabId) => ipcRenderer.invoke('desktop:restart-tab', tabId),
  writeTab: (tabId, data) => ipcRenderer.invoke('desktop:write-tab', tabId, data),
  resizeTab: (tabId, cols, rows) => ipcRenderer.invoke('desktop:resize-tab', tabId, cols, rows),
  getTabBacklog: (tabId) => ipcRenderer.invoke('desktop:get-tab-backlog', tabId),
  openSettings: () => ipcRenderer.invoke('desktop:open-settings'),
  showSessionLog: (tabId) => ipcRenderer.invoke('desktop:show-session-log', tabId),
  copyDiagnostics: () => ipcRenderer.invoke('desktop:copy-diagnostics'),
  retryResolution: () => ipcRenderer.invoke('desktop:retry-resolution'),
  onStateChanged: (listener) => {
    const handler = (_event, state) => listener(state)
    ipcRenderer.on('desktop:state-changed', handler)
    return () => ipcRenderer.removeListener('desktop:state-changed', handler)
  },
  onTabOutput: (listener) => {
    const handler = (_event, payload) => listener(payload)
    ipcRenderer.on('desktop:tab-output', handler)
    return () => ipcRenderer.removeListener('desktop:tab-output', handler)
  },
  onTabExit: (listener) => {
    const handler = (_event, payload) => listener(payload)
    ipcRenderer.on('desktop:tab-exit', handler)
    return () => ipcRenderer.removeListener('desktop:tab-exit', handler)
  },
})
