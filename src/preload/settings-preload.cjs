const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('copilotDesktopSettings', {
  get: () => ipcRenderer.invoke('desktop-settings:get'),
  updatePreferences: (preferences) => ipcRenderer.invoke('desktop-settings:update-preferences', preferences),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('desktop-settings:set-launch-at-login', enabled),
  updateWorkspaceProfile: (profileId, name, permissionPreset, defaultResumeMode) =>
    ipcRenderer.invoke('desktop-settings:update-workspace-profile', profileId, name, permissionPreset, defaultResumeMode),
  updateProvider: (provider) => ipcRenderer.invoke('desktop-settings:update-provider', provider),
  checkForUpdates: () => ipcRenderer.invoke('desktop-settings:check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('desktop-settings:download-update'),
  installUpdate: () => ipcRenderer.invoke('desktop-settings:install-update'),
  openReleases: () => ipcRenderer.invoke('desktop-settings:open-releases'),
  openRollbackRelease: () => ipcRenderer.invoke('desktop-settings:open-rollback-release'),
  saveCredential: (name, secret) => ipcRenderer.invoke('desktop-settings:save-credential', name, secret),
  deleteCredential: (name) => ipcRenderer.invoke('desktop-settings:delete-credential', name),
  onUpdateStateChanged: (listener) => {
    const handler = (_event, state) => listener(state)
    ipcRenderer.on('desktop-settings:update-state-changed', handler)
    return () => ipcRenderer.removeListener('desktop-settings:update-state-changed', handler)
  },
})
