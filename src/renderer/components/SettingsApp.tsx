import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { CredentialName } from '../../main/secure-credentials.js'
import type { PermissionPreset } from '../../main/permission-presets.js'
import type { ResumeMode } from '../../main/resume-args.js'
import type { DesktopSettingsSnapshot } from '../global.js'

const PERMISSION_OPTIONS: Array<{ value: PermissionPreset; label: string }> = [
  { value: 'default', label: 'Default (prompt every time)' },
  { value: 'trusted-directory', label: 'Trusted directory' },
  { value: 'full-auto', label: 'Full auto (--allow-all-tools)' },
]

const RESUME_OPTIONS: Array<{ value: ResumeMode; label: string }> = [
  { value: 'new', label: 'Always start a new session' },
  { value: 'auto-resume', label: 'Auto-resume the last known session' },
  { value: 'continue', label: 'Continue the most recent session (--continue)' },
]

const CREDENTIAL_LABELS: Record<CredentialName, string> = {
  COPILOT_PROVIDER_BASE_URL: 'COPILOT_PROVIDER_BASE_URL (BYOK base URL)',
  COPILOT_PROVIDER_API_KEY: 'COPILOT_PROVIDER_API_KEY (BYOK API key)',
  GH_TOKEN: 'GH_TOKEN (GitHub auth override)',
}

export function SettingsApp(): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<DesktopSettingsSnapshot | null>(null)
  const [credentialDrafts, setCredentialDrafts] = useState<Record<string, string>>({})
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    void window.copilotDesktopSettings.get().then(setSnapshot)
    const unsubscribe = window.copilotDesktopSettings.onUpdateStateChanged((update) => {
      setSnapshot((previous) => (previous ? { ...previous, update } : previous))
    })
    return unsubscribe
  }, [])

  if (!snapshot) return <div className="loading-screen"><p>Loading settings…</p></div>

  const refresh = (next: DesktopSettingsSnapshot): void => setSnapshot(next)
  const showMessage = (text: string): void => {
    setMessage(text)
    setTimeout(() => setMessage(null), 3_000)
  }
  // Toggling two checkboxes in quick succession — before the first
  // updatePreferences() IPC round-trip resolves — must not let the second
  // call build its payload from the pre-toggle snapshot and revert the
  // first change. Reading `previous` from React's functional-update form
  // guarantees each call sees the latest (optimistically applied) state,
  // even when several fire before any IPC response lands.
  const updatePreference = (
    patch: Partial<Pick<
      DesktopSettingsSnapshot,
      'closeToTray' | 'trayEnabled' | 'notifications' | 'automaticUpdateChecks' | 'globalShortcutEnabled'
    >>,
  ): void => {
    setSnapshot((previous) => {
      if (!previous) return previous
      const next = { ...previous, ...patch }
      void window.copilotDesktopSettings
        .updatePreferences({
          closeToTray: next.closeToTray,
          trayEnabled: next.trayEnabled,
          notifications: next.notifications,
          automaticUpdateChecks: next.automaticUpdateChecks,
          globalShortcutEnabled: next.globalShortcutEnabled,
        })
        .then(refresh)
      return next
    })
  }

  return (
    <div className="settings-app">
      {message && <div className="settings-toast">{message}</div>}

      <section>
        <h2>General</h2>
        <label className="settings-row">
          <input
            type="checkbox"
            checked={snapshot.closeToTray}
            onChange={(event) => updatePreference({ closeToTray: event.target.checked })}
          />
          Keep sessions running in the background when the window is closed
        </label>
        <label className="settings-row">
          <input
            type="checkbox"
            checked={snapshot.trayEnabled}
            onChange={(event) => updatePreference({ trayEnabled: event.target.checked })}
          />
          Show a tray icon
        </label>
        <label className="settings-row">
          <input
            type="checkbox"
            checked={snapshot.notifications}
            onChange={(event) => updatePreference({ notifications: event.target.checked })}
          />
          Show native notifications (approval needed, session finished/crashed)
        </label>
        <label className="settings-row">
          <input
            type="checkbox"
            checked={snapshot.globalShortcutEnabled}
            onChange={(event) => updatePreference({ globalShortcutEnabled: event.target.checked })}
          />
          Register {snapshot.globalShortcutAccelerator} to show/hide the window
        </label>
        <label className="settings-row">
          <input
            type="checkbox"
            checked={snapshot.launchAtLogin}
            disabled={!snapshot.launchAtLoginAvailable}
            onChange={(event) =>
              void window.copilotDesktopSettings.setLaunchAtLogin(event.target.checked).then(refresh)
            }
          />
          Launch at sign-in{!snapshot.launchAtLoginAvailable ? ' (installed builds only)' : ''}
        </label>
      </section>

      <section>
        <h2>Workspace profiles</h2>
        {snapshot.profiles.length === 0 && <p>No workspaces yet. Choose one from the main window.</p>}
        {snapshot.profiles.map((profile) => (
          <div key={profile.id} className="profile-row">
            <div className="profile-path">{profile.path}</div>
            <select
              value={profile.permissionPreset}
              onChange={(event) =>
                void window.copilotDesktopSettings
                  .updateWorkspaceProfile(profile.id, profile.name, event.target.value as PermissionPreset, profile.defaultResumeMode)
                  .then(refresh)
              }
            >
              {PERMISSION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <select
              value={profile.defaultResumeMode}
              onChange={(event) =>
                void window.copilotDesktopSettings
                  .updateWorkspaceProfile(profile.id, profile.name, profile.permissionPreset, event.target.value as ResumeMode)
                  .then(refresh)
              }
            >
              {RESUME_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
        ))}
      </section>

      <section>
        <h2>Protected credential vault</h2>
        <p>
          Values are encrypted with Windows DPAPI via Electron <code>safeStorage</code> and injected only into
          spawned <code>copilot</code> sessions — never returned to any renderer. If protected storage is
          unavailable, saving is refused rather than falling back to plaintext.
        </p>
        {!snapshot.credentials?.available && <p className="settings-warning">Protected storage is unavailable in this session.</p>}
        {snapshot.credentials?.entries.map((entry) => (
          <div key={entry.name} className="credential-row">
            <label>{CREDENTIAL_LABELS[entry.name]}</label>
            <div className="credential-status">
              {entry.configured ? `Configured (${entry.source})` : 'Not configured'}
            </div>
            <input
              type="password"
              placeholder="Enter a new value"
              value={credentialDrafts[entry.name] ?? ''}
              onChange={(event) => setCredentialDrafts((prev) => ({ ...prev, [entry.name]: event.target.value }))}
            />
            <button
              type="button"
              disabled={!snapshot.credentials?.available || !credentialDrafts[entry.name]}
              onClick={() =>
                void window.copilotDesktopSettings.saveCredential(entry.name, credentialDrafts[entry.name] ?? '').then((next) => {
                  refresh(next)
                  setCredentialDrafts((prev) => ({ ...prev, [entry.name]: '' }))
                  showMessage('Saved protected credential.')
                })
              }
            >
              Save
            </button>
            <button
              type="button"
              disabled={!entry.configured || entry.source !== 'protected-store'}
              onClick={() => void window.copilotDesktopSettings.deleteCredential(entry.name).then(refresh)}
            >
              Remove
            </button>
          </div>
        ))}
      </section>

      <section>
        <h2>Updates</h2>
        <p>{snapshot.update.message}</p>
        <div className="settings-actions">
          <button
            type="button"
            disabled={!snapshot.update.canCheck}
            onClick={() => void window.copilotDesktopSettings.checkForUpdates().then(refresh)}
          >
            Check for updates
          </button>
          <button
            type="button"
            disabled={!snapshot.update.canDownload}
            onClick={() => void window.copilotDesktopSettings.downloadUpdate().then(refresh)}
          >
            Download
          </button>
          <button
            type="button"
            disabled={!snapshot.update.canInstall}
            onClick={() => void window.copilotDesktopSettings.installUpdate()}
          >
            Install and restart
          </button>
          <button type="button" onClick={() => void window.copilotDesktopSettings.openReleases()}>
            View releases
          </button>
        </div>
        {snapshot.rollbackVersion && <p>Previous version: {snapshot.rollbackVersion}</p>}
      </section>

      <p className="settings-disclaimer">
        Copilot CLI Desktop is an unofficial, community-built wrapper around the public <code>copilot</code> CLI.
        It is not affiliated with, endorsed by, or supported by GitHub or Microsoft.
      </p>
    </div>
  )
}
