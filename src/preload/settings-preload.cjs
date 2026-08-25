const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('copilotDesktopSettings', {
  get: () => ipcRenderer.invoke('desktop-settings:get'),
  updatePreferences: (preferences) => ipcRenderer.invoke('desktop-settings:update-preferences', preferences),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('desktop-settings:set-launch-at-login', enabled),
  updateWorkspaceProfile: (profileId, name, permissionPreset, defaultResumeMode, launch) =>
    ipcRenderer.invoke('desktop-settings:update-workspace-profile', profileId, name, permissionPreset, defaultResumeMode, launch),
  updateProvider: (provider) => ipcRenderer.invoke('desktop-settings:update-provider', provider),
  checkForUpdates: () => ipcRenderer.invoke('desktop-settings:check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('desktop-settings:download-update'),
  installUpdate: () => ipcRenderer.invoke('desktop-settings:install-update'),
  openReleases: () => ipcRenderer.invoke('desktop-settings:open-releases'),
  openRollbackRelease: () => ipcRenderer.invoke('desktop-settings:open-rollback-release'),
  saveCredential: (name, secret) => ipcRenderer.invoke('desktop-settings:save-credential', name, secret),
  deleteCredential: (name) => ipcRenderer.invoke('desktop-settings:delete-credential', name),
  installCopilot: () => ipcRenderer.invoke('desktop-settings:install-copilot'),
  updateCopilot: () => ipcRenderer.invoke('desktop-settings:update-copilot'),
  refreshCopilotResources: () => ipcRenderer.invoke('desktop-settings:refresh-copilot-resources'),
  mutateCopilotResource: (action, kind, name) =>
    ipcRenderer.invoke('desktop-settings:mutate-copilot-resource', action, kind, name),
  installCopilotPlugin: (source) => ipcRenderer.invoke('desktop-settings:install-copilot-plugin', source),
  installCopilotSkill: (source, project) => ipcRenderer.invoke('desktop-settings:install-copilot-skill', source, project),
  addCopilotMcp: (name, url, transport) => ipcRenderer.invoke('desktop-settings:add-copilot-mcp', name, url, transport),
  openCopilotConfig: () => ipcRenderer.invoke('desktop-settings:open-copilot-config'),
  onUpdateStateChanged: (listener) => {
    const handler = (_event, state) => listener(state)
    ipcRenderer.on('desktop-settings:update-state-changed', handler)
    return () => ipcRenderer.removeListener('desktop-settings:update-state-changed', handler)
  },
})
