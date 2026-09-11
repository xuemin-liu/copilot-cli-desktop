const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('copilotDesktopSettings', {
  migrationInventory: (selection) => ipcRenderer.invoke('desktop-settings:migration-inventory', selection),
  migrationExport: (selection) => ipcRenderer.invoke('desktop-settings:migration-export', selection),
  migrationOpen: () => ipcRenderer.invoke('desktop-settings:migration-open'),
  migrationMap: (id) => ipcRenderer.invoke('desktop-settings:migration-map', id),
  migrationPreview: (choices) => ipcRenderer.invoke('desktop-settings:migration-preview', choices),
  migrationApply: (id) => ipcRenderer.invoke('desktop-settings:migration-apply', id),
  migrationCancel: () => ipcRenderer.invoke('desktop-settings:migration-cancel'),
  migrationStatus: () => ipcRenderer.invoke('desktop-settings:migration-status'),
  migrationRecover: () => ipcRenderer.invoke('desktop-settings:migration-recover'),
  migrationDismissRecovery: (id, sha256) => ipcRenderer.invoke('desktop-settings:migration-dismiss-recovery', id, sha256),
  migrationBackups: () => ipcRenderer.invoke('desktop-settings:migration-backups'),
  migrationDeleteBackup: (id, token) => ipcRenderer.invoke('desktop-settings:migration-delete-backup', id, token),
  onMigrationProgress: (listener) => {
    const handler = (_event, progress) => listener(progress)
    ipcRenderer.on('desktop-settings:migration-progress', handler)
    return () => ipcRenderer.removeListener('desktop-settings:migration-progress', handler)
  },
  usageReport: (month, scope, timezone) => ipcRenderer.invoke('desktop-settings:usage-report', month, scope, timezone),
  refreshUsage: () => ipcRenderer.invoke('desktop-settings:usage-refresh'),
  exportUsage: () => ipcRenderer.invoke('desktop-settings:usage-export'),
  restoreUsage: () => ipcRenderer.invoke('desktop-settings:usage-restore'),
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
  setCopilotAutoUpdate: (enabled, channel) =>
    ipcRenderer.invoke('desktop-settings:set-copilot-auto-update', enabled, channel),
  recheckCopilotCapabilities: () => ipcRenderer.invoke('desktop-settings:recheck-copilot-capabilities'),
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
  onPreferencesChanged: (listener) => {
    const handler = (_event, preferences) => listener(preferences)
    ipcRenderer.on('desktop-settings:preferences-changed', handler)
    return () => ipcRenderer.removeListener('desktop-settings:preferences-changed', handler)
  },
  onCopilotStateChanged: (listener) => {
    const handler = (_event, state) => listener(state)
    ipcRenderer.on('desktop-settings:copilot-state-changed', handler)
    return () => ipcRenderer.removeListener('desktop-settings:copilot-state-changed', handler)
  },
})
