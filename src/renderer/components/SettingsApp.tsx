import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { CredentialName } from '../../main/secure-credentials.js'
import type { PermissionPreset } from '../../main/permission-presets.js'
import type { ResumeMode } from '../../main/resume-args.js'
import type { DesktopSettingsSnapshot } from '../global.js'
import type { CopilotProviderConfig } from '../../main/provider-config.js'
import type { WorkspaceProfile } from '../../main/types.js'

const PERMISSION_OPTIONS: Array<{ value: PermissionPreset; label: string }> = [
  { value: 'default', label: 'Default (prompt every time)' },
  { value: 'read-only', label: 'Restricted (deny current shell/write tools)' },
  { value: 'trusted-directory', label: 'Trusted directory' },
  { value: 'full-auto', label: 'Full auto (--allow-all-tools)' },
  { value: 'full-access', label: 'Full computer access (--allow-all)' },
]

const RESUME_OPTIONS: Array<{ value: ResumeMode; label: string }> = [
  { value: 'new', label: 'Always start a new session' },
  { value: 'auto-resume', label: 'Auto-resume the last known session' },
  { value: 'continue', label: 'Continue the most recent session (--continue)' },
]

const CREDENTIAL_LABELS: Record<CredentialName, string> = {
  COPILOT_PROVIDER_BASE_URL: 'COPILOT_PROVIDER_BASE_URL (legacy protected endpoint)',
  COPILOT_PROVIDER_API_KEY: 'COPILOT_PROVIDER_API_KEY (BYOK API key)',
  COPILOT_GITHUB_TOKEN: 'COPILOT_GITHUB_TOKEN (preferred GitHub token)',
  GH_TOKEN: 'GH_TOKEN (GitHub auth override)',
  GITHUB_TOKEN: 'GITHUB_TOKEN (GitHub auth fallback)',
}

function WorkspaceProfileEditor({
  profile,
  active,
  onSaved,
}: {
  profile: WorkspaceProfile
  active: boolean
  onSaved: (snapshot: DesktopSettingsSnapshot) => void
}): JSX.Element {
  const [name, setName] = useState(profile.name)
  const [permissionPreset, setPermissionPreset] = useState(profile.permissionPreset)
  const [defaultResumeMode, setDefaultResumeMode] = useState(profile.defaultResumeMode)

  return (
    <div className="settings-card">
      <div className="settings-card-heading">
        <strong>{profile.name}</strong>
        <span>{active ? 'Active' : 'Recent'}</span>
      </div>
      <div className="profile-path">{profile.path}</div>
      <div className="settings-form-grid">
        <label>
          Profile name
          <input type="text" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Startup permission
          <select value={permissionPreset} onChange={(event) => setPermissionPreset(event.target.value as PermissionPreset)}>
            {PERMISSION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label>
          Session restoration
          <select value={defaultResumeMode} onChange={(event) => setDefaultResumeMode(event.target.value as ResumeMode)}>
            {RESUME_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>
      <button
        type="button"
        onClick={() => void window.copilotDesktopSettings
          .updateWorkspaceProfile(profile.id, name, permissionPreset, defaultResumeMode)
          .then(onSaved)}
      >
        Save profile
      </button>
    </div>
  )
}

function ProviderSettings({
  provider,
  onSaved,
}: {
  provider: CopilotProviderConfig
  onSaved: (snapshot: DesktopSettingsSnapshot) => void
}): JSX.Element {
  const [draft, setDraft] = useState(provider)
  const custom = draft.type !== 'github'
  return (
    <section>
      <h2>Model provider</h2>
      <p>Use GitHub-hosted models or configure an official Copilot CLI BYOK provider.</p>
      <div className="settings-form-grid">
        <label>
          Provider
          <select
            value={draft.type}
            onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value as CopilotProviderConfig['type'] }))}
          >
            <option value="github">GitHub Copilot</option>
            <option value="openai">OpenAI-compatible</option>
            <option value="azure">Azure OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </label>
        <label>
          Model
          <input
            type="text"
            disabled={!custom}
            value={draft.model}
            placeholder="Model or deployment identifier"
            onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
          />
        </label>
        <label className="settings-grid-wide">
          Provider base URL
          <input
            type="url"
            disabled={!custom}
            value={draft.baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))}
          />
        </label>
      </div>
      <label className="settings-row">
        <input
          type="checkbox"
          disabled={!custom}
          checked={draft.offline}
          onChange={(event) => setDraft((current) => ({ ...current, offline: event.target.checked }))}
        />
        Offline mode (prevent GitHub network access; the configured provider may still be remote)
      </label>
      <button type="button" onClick={() => void window.copilotDesktopSettings.updateProvider(draft).then(onSaved)}>
        Save provider
      </button>
      <p className="settings-disclaimer">Provider changes apply to new Copilot sessions.</p>
    </section>
  )
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
          <WorkspaceProfileEditor
            key={profile.id}
            profile={profile}
            active={profile.id === snapshot.activeProfileId}
            onSaved={refresh}
          />
        ))}
      </section>

      <section>
        <h2>Access status</h2>
        <dl className="settings-definition-list">
          <div><dt>Copilot permission</dt><dd>{snapshot.access.permissionLabel} ({snapshot.access.permissionSource})</dd></div>
          <div><dt>Windows process</dt><dd>{snapshot.access.elevation === 'administrator' ? 'Administrator' : snapshot.access.elevation === 'standard-user' ? 'Standard user' : 'Unknown'}</dd></div>
        </dl>
        {snapshot.access.warning && <p className="settings-warning">{snapshot.access.warning}</p>}
        <p className="settings-disclaimer">Permissions control Copilot CLI launch flags; they cannot remove rights already held by this Windows account.</p>
      </section>

      <ProviderSettings provider={snapshot.provider} onSaved={refresh} />

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
        <p>Desktop {snapshot.update.currentVersion} · Copilot CLI {snapshot.cliVersion ?? 'not detected'}{snapshot.update.availableVersion ? ` · Available ${snapshot.update.availableVersion}` : ''}</p>
        <p>{snapshot.update.message}</p>
        {snapshot.update.downloadPercent !== null && <progress max={100} value={snapshot.update.downloadPercent} />}
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
          {snapshot.rollbackVersion && (
            <button type="button" onClick={() => void window.copilotDesktopSettings.openRollbackRelease()}>
              Open rollback v{snapshot.rollbackVersion}
            </button>
          )}
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
