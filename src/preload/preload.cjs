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
  gitSync: (profileId, repoId, operation, remote, expected) => ipcRenderer.invoke('desktop:git-sync', profileId, repoId, operation, remote ?? null, expected ?? null),
  gitHeadCommit: (profileId, repoId) => ipcRenderer.invoke('desktop:git-head-commit', profileId, repoId),
  gitAmend: (profileId, repoId, message, generation, approvedHooksHash, expected) => ipcRenderer.invoke('desktop:git-amend', profileId, repoId, message, generation, approvedHooksHash ?? null, expected),
  gitDiscard: (profileId, repoId, entryIds, generation) => ipcRenderer.invoke('desktop:git-discard', profileId, repoId, entryIds, generation),
  gitBranches: (profileId, repoId) => ipcRenderer.invoke('desktop:git-branches', profileId, repoId),
  gitWorktrees: (profileId, repoId) => ipcRenderer.invoke('desktop:git-worktrees', profileId, repoId),
  gitWorktreeRemove: (profileId, repoId, path) => ipcRenderer.invoke('desktop:git-worktree-remove', profileId, repoId, path),
  gitBranch: (profileId, repoId, action, name, expected) => ipcRenderer.invoke('desktop:git-branch', profileId, repoId, action, name, expected),
  gitCancel: (profileId, repoId) => ipcRenderer.invoke('desktop:git-cancel', profileId, repoId),
  onGitProgress: (listener) => {
    const handler = (_event, payload) => listener(payload)
    ipcRenderer.on('desktop:git-progress', handler)
    return () => ipcRenderer.removeListener('desktop:git-progress', handler)
  },
  gitStatus: (profileId, repoId) => ipcRenderer.invoke('desktop:git-status', profileId, repoId),
  gitDiff: (profileId, repoId, entryId, staged, wholeFile) => ipcRenderer.invoke('desktop:git-diff', profileId, repoId, entryId, staged, wholeFile),
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
  removeProfile: (profileId) => ipcRenderer.invoke('desktop:remove-profile', profileId),
  createTab: (resumeMode, profileId, title, options) => ipcRenderer.invoke('desktop:create-tab', resumeMode ?? null, profileId, title ?? null, options ?? null),
  listSessionWorktrees: (profileId) => ipcRenderer.invoke('desktop:list-session-worktrees', profileId),
  createTabWithAttachments: (title, options) => ipcRenderer.invoke('desktop:create-tab-with-attachments', title ?? null, options ?? null),
  onNewSessionRequest: (listener) => {
    const handler = (_event, attachments) => listener(attachments === true)
    ipcRenderer.on('desktop:new-session-request', handler)
    return () => ipcRenderer.removeListener('desktop:new-session-request', handler)
  },
  listSessionHistory: () => ipcRenderer.invoke('desktop:list-session-history'),
  openSessionHistory: (sessionId) => ipcRenderer.invoke('desktop:open-session-history', sessionId),
  onSessionHistoryRequest: (listener) => {
    const handler = () => listener()
    ipcRenderer.on('desktop:session-history-request', handler)
    return () => ipcRenderer.removeListener('desktop:session-history-request', handler)
  },
  onSidebarViewRequest: (listener) => {
    const handler = (_event, change) => listener(change)
    ipcRenderer.on('desktop:sidebar-view-request', handler)
    return () => ipcRenderer.removeListener('desktop:sidebar-view-request', handler)
  },
  reportSidebarView: (view) => ipcRenderer.invoke('desktop:sidebar-view-changed', view),
  fanOut: (profileId, label, count) => ipcRenderer.invoke('desktop:fan-out', profileId, label, count),
  connectRemoteSession: (sessionId) => ipcRenderer.invoke('desktop:connect-remote-session', sessionId),
  activateTab: (tabId) => ipcRenderer.invoke('desktop:activate-tab', tabId),
  popOutTab: (tabId) => ipcRenderer.invoke('desktop:pop-out-tab', tabId),
  dockTab: (tabId) => ipcRenderer.invoke('desktop:dock-tab', tabId),
  popOutBrowser: (tabId) => ipcRenderer.invoke('desktop:pop-out-browser', tabId),
  dockBrowser: (tabId) => ipcRenderer.invoke('desktop:dock-browser', tabId),
  desktopControlSet: (tabId, enabled) => ipcRenderer.invoke('desktop:desktop-control-set', tabId, enabled),
  desktopControlResume: (tabId) => ipcRenderer.invoke('desktop:desktop-control-resume', tabId),
  desktopControlRevoke: (tabId, key) => ipcRenderer.invoke('desktop:desktop-control-revoke', tabId, key),
  desktopControlFullScreen: (tabId, allowed) => ipcRenderer.invoke('desktop:desktop-control-full-screen', tabId, allowed),
  browserInsertPrompt: (tabId, detail) => ipcRenderer.invoke('desktop:browser-insert-prompt', tabId, detail),
  onInsertPromptRequest: (listener) => {
    const handler = (_event, id, detail) => void ipcRenderer.invoke('desktop:insert-prompt-result', id, listener(detail) === true)
    ipcRenderer.on('desktop:insert-prompt', handler)
    return () => ipcRenderer.removeListener('desktop:insert-prompt', handler)
  },
  renameTab: (tabId, title) => ipcRenderer.invoke('desktop:rename-tab', tabId, title),
  closeTab: (tabId) => ipcRenderer.invoke('desktop:close-tab', tabId),
  restartTab: (tabId) => ipcRenderer.invoke('desktop:restart-tab', tabId),
  unloadTab: (tabId) => ipcRenderer.invoke('desktop:unload-tab', tabId),
  forkSideChat: (tabId, sourceSessionId, title) => ipcRenderer.invoke('desktop:fork-side-chat', tabId, sourceSessionId, title),
  writeTab: (tabId, data, gitCursorContext) => ipcRenderer.invoke('desktop:write-tab', tabId, data, gitCursorContext),
  gitResolve: (profileId, repoId, tabId, text) => ipcRenderer.invoke('desktop:git-resolve', profileId, repoId, tabId, text),
  meetingAction: (meetingId, action, tabId, role) => ipcRenderer.invoke('desktop:meeting-action', meetingId, action, tabId, role),
  meetingInvite: (meetingId, name, role, short) => ipcRenderer.invoke('desktop:meeting-invite', meetingId, name, role, short),
  meetingHostInvite: (folder, short) => ipcRenderer.invoke('desktop:meeting-host-invite', folder, short),
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
