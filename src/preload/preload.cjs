const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('copilotDesktop', {
  getState: () => ipcRenderer.invoke('desktop:get-state'),
  browserOpen: (tabId) => ipcRenderer.invoke('desktop:browser-open', tabId),
  browserState: (tabId) => ipcRenderer.invoke('desktop:browser-state', tabId),
  browserNavigate: (tabId, url) => ipcRenderer.invoke('desktop:browser-navigate', tabId, url),
  browserAction: (tabId, action) => ipcRenderer.invoke('desktop:browser-action', tabId, action),
  browserPick: (tabId) => ipcRenderer.invoke('desktop:browser-pick', tabId),
  browserPickMany: (tabId) => ipcRenderer.invoke('desktop:browser-pick-many', tabId),
  onBrowserPicked: (listener) => {
    const handler = (_event, tabId, text) => listener(tabId, text)
    ipcRenderer.on('desktop:browser-picked', handler)
    return () => ipcRenderer.removeListener('desktop:browser-picked', handler)
  },
  browserDialog: (tabId, accept) => ipcRenderer.invoke('desktop:browser-dialog', tabId, accept),
  browserScreenshot: (tabId) => ipcRenderer.invoke('desktop:browser-screenshot', tabId),
  browserFind: (tabId, text, forward, next) => ipcRenderer.invoke('desktop:browser-find', tabId, text, forward, next),
  browserFindStop: (tabId) => ipcRenderer.invoke('desktop:browser-find-stop', tabId),
  onBrowserShortcut: (listener) => {
    const handler = (_event, tabId, name) => listener(tabId, name)
    ipcRenderer.on('desktop:browser-shortcut', handler)
    return () => ipcRenderer.removeListener('desktop:browser-shortcut', handler)
  },
  browserPickCancel: (tabId) => ipcRenderer.invoke('desktop:browser-pick-cancel', tabId),
  browserExport: (tabId, kind) => ipcRenderer.invoke('desktop:browser-export', tabId, kind),
  browserBounds: (tabId, bounds) => ipcRenderer.invoke('desktop:browser-bounds', tabId, bounds),
  gitOpen: (profileId) => ipcRenderer.invoke('desktop:git-open', profileId),
  gitClose: (profileId) => ipcRenderer.invoke('desktop:git-close', profileId),
  gitRescan: (profileId) => ipcRenderer.invoke('desktop:git-rescan', profileId),
  gitTrust: (profileId, repoId, configHash) => ipcRenderer.invoke('desktop:git-trust', profileId, repoId, configHash),
  gitStage: (profileId, repoId, entryIds, generation) => ipcRenderer.invoke('desktop:git-stage', profileId, repoId, entryIds, generation),
  gitUnstage: (profileId, repoId, entryIds, generation) => ipcRenderer.invoke('desktop:git-unstage', profileId, repoId, entryIds, generation),
  gitCommit: (profileId, repoId, message, generation, approvedHooksHash) => ipcRenderer.invoke('desktop:git-commit', profileId, repoId, message, generation, approvedHooksHash ?? null),
  gitCancel: (profileId, repoId) => ipcRenderer.invoke('desktop:git-cancel', profileId, repoId),
  onGitProgress: (listener) => {
    const handler = (_event, payload) => listener(payload)
    ipcRenderer.on('desktop:git-progress', handler)
    return () => ipcRenderer.removeListener('desktop:git-progress', handler)
  },
  gitStatus: (profileId, repoId) => ipcRenderer.invoke('desktop:git-status', profileId, repoId),
  gitDiff: (profileId, repoId, entryId, staged) => ipcRenderer.invoke('desktop:git-diff', profileId, repoId, entryId, staged),
  gitLog: (profileId, repoId, limit, skip) => ipcRenderer.invoke('desktop:git-log', profileId, repoId, limit, skip),
  onGitToggle: (listener) => {
    const handler = () => listener()
    ipcRenderer.on('desktop:git-toggle', handler)
    return () => ipcRenderer.removeListener('desktop:git-toggle', handler)
  },
  onGitChanged: (listener) => {
    const handler = (_event, payload) => listener(payload)
    ipcRenderer.on('desktop:git-changed', handler)
    return () => ipcRenderer.removeListener('desktop:git-changed', handler)
  },
  selectWorkspace: () => ipcRenderer.invoke('desktop:select-workspace'),
  activateProfile: (profileId) => ipcRenderer.invoke('desktop:activate-profile', profileId),
  createTab: (resumeMode, profileId) => ipcRenderer.invoke('desktop:create-tab', resumeMode ?? null, profileId),
  createTabWithAttachments: () => ipcRenderer.invoke('desktop:create-tab-with-attachments'),
  connectRemoteSession: (sessionId) => ipcRenderer.invoke('desktop:connect-remote-session', sessionId),
  activateTab: (tabId) => ipcRenderer.invoke('desktop:activate-tab', tabId),
  popOutTab: (tabId) => ipcRenderer.invoke('desktop:pop-out-tab', tabId),
  dockTab: (tabId) => ipcRenderer.invoke('desktop:dock-tab', tabId),
  renameTab: (tabId, title) => ipcRenderer.invoke('desktop:rename-tab', tabId, title),
  closeTab: (tabId) => ipcRenderer.invoke('desktop:close-tab', tabId),
  restartTab: (tabId) => ipcRenderer.invoke('desktop:restart-tab', tabId),
  forkSideChat: (tabId, sourceSessionId, title) => ipcRenderer.invoke('desktop:fork-side-chat', tabId, sourceSessionId, title),
  writeTab: (tabId, data) => ipcRenderer.invoke('desktop:write-tab', tabId, data),
  resizeTab: (tabId, cols, rows) => ipcRenderer.invoke('desktop:resize-tab', tabId, cols, rows),
  getTabBacklog: (tabId) => ipcRenderer.invoke('desktop:get-tab-backlog', tabId),
  getTabSnapshot: (tabId) => ipcRenderer.invoke('desktop:get-tab-snapshot', tabId),
  openSettings: () => ipcRenderer.invoke('desktop:open-settings'),
  showSessionLog: (tabId) => ipcRenderer.invoke('desktop:show-session-log', tabId),
  copyText: (text) => ipcRenderer.invoke('desktop:copy-text', text),
  showTerminalContextMenu: (text) => ipcRenderer.invoke('desktop:show-terminal-context-menu', text),
  openExternalUrl: (url) => ipcRenderer.invoke('desktop:open-external-url', url),
  revealPath: (tabId, path) => ipcRenderer.invoke('desktop:reveal-path', tabId, path),
  copyDiagnostics: () => ipcRenderer.invoke('desktop:copy-diagnostics'),
  retryResolution: () => ipcRenderer.invoke('desktop:retry-resolution'),
  installCopilot: () => ipcRenderer.invoke('desktop:install-copilot'),
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
