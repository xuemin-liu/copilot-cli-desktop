import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { CredentialName } from '../../main/secure-credentials.js'
import { PERMISSION_PRESET_INFO, PERMISSION_PRESETS, type PermissionPreset } from '../../main/permission-presets.js'
import type { ResumeMode } from '../../main/resume-args.js'
import type { DesktopSettingsSnapshot } from '../global.js'
import type { CopilotProviderConfig } from '../../main/provider-config.js'
import type { WorkspaceProfile } from '../../main/types.js'
import type { SessionLaunchConfig } from '../../main/session-launch.js'
import type { CopilotResourceAction, CopilotResourceKind } from '../../main/copilot-resources.js'

const PERMISSION_OPTIONS: Array<{ value: PermissionPreset; label: string }> = PERMISSION_PRESETS.map((value) => ({
  value,
  label: PERMISSION_PRESET_INFO[value].label,
}))

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
  const [launch, setLaunch] = useState<SessionLaunchConfig>(profile.launch)

  const nullableNumber = (value: string): number | null => value === '' ? null : Number(value)

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
        <label>
          Initial model
          <input
            type="text"
            value={launch.model}
            placeholder="Auto / saved Copilot default"
            onChange={(event) => setLaunch((current) => ({ ...current, model: event.target.value }))}
          />
        </label>
        <label>
          Custom agent
          <input
            type="text"
            value={launch.agent}
            placeholder="Default agent"
            onChange={(event) => setLaunch((current) => ({ ...current, agent: event.target.value }))}
          />
        </label>
        <label>
          Reasoning effort
          <select
            value={launch.reasoningEffort}
            onChange={(event) => setLaunch((current) => ({
              ...current,
              reasoningEffort: event.target.value as SessionLaunchConfig['reasoningEffort'],
            }))}
          >
            <option value="default">Model default</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh">Extra high</option>
            <option value="max">Maximum</option>
          </select>
        </label>
        <label>
          Context window
          <select
            value={launch.contextTier}
            onChange={(event) => setLaunch((current) => ({
              ...current,
              contextTier: event.target.value as SessionLaunchConfig['contextTier'],
            }))}
          >
            <option value="default">Default</option>
            <option value="long_context">Long context</option>
          </select>
        </label>
        <label>
          Initial mode
          <select
            value={launch.mode}
            onChange={(event) => setLaunch((current) => ({
              ...current,
              mode: event.target.value as SessionLaunchConfig['mode'],
            }))}
          >
            <option value="interactive">Interactive</option>
            <option value="plan">Plan</option>
            <option value="autopilot">Autopilot</option>
            <option value="plan-autopilot">Plan, then autopilot</option>
          </select>
        </label>
        <label>
          Autopilot continuation limit
          <input
            type="number"
            min={0}
            max={10000}
            value={launch.maxAutopilotContinues ?? ''}
            placeholder="Unlimited"
            onChange={(event) => setLaunch((current) => ({
              ...current,
              maxAutopilotContinues: nullableNumber(event.target.value),
            }))}
          />
        </label>
        <label>
          AI credit limit
          <input
            type="number"
            min={1}
            max={100000}
            value={launch.maxAiCredits ?? ''}
            placeholder="Copilot default"
            onChange={(event) => setLaunch((current) => ({
              ...current,
              maxAiCredits: nullableNumber(event.target.value),
            }))}
          />
        </label>
        <label>
          Remote control
          <select
            value={launch.remoteControl}
            onChange={(event) => setLaunch((current) => ({
              ...current,
              remoteControl: event.target.value as SessionLaunchConfig['remoteControl'],
            }))}
          >
            <option value="inherit">Use Copilot setting</option>
            <option value="enable">Enable</option>
            <option value="disable">Disable</option>
          </select>
        </label>
        <label>
          Session export/sync
          <select
            value={launch.remoteExport}
            onChange={(event) => setLaunch((current) => ({
              ...current,
              remoteExport: event.target.value as SessionLaunchConfig['remoteExport'],
            }))}
          >
            <option value="inherit">Use Copilot setting</option>
            <option value="enable">Enable export</option>
            <option value="disable">Disable export</option>
          </select>
        </label>
      </div>
      <label className="settings-row">
        <input
          type="checkbox"
          checked={launch.worktree}
          onChange={(event) => setLaunch((current) => ({ ...current, worktree: event.target.checked }))}
        />
        Start fresh sessions in an isolated Git worktree
      </label>
      <label className="settings-row">
        <input
          type="checkbox"
          checked={launch.screenReader}
          onChange={(event) => setLaunch((current) => ({ ...current, screenReader: event.target.checked }))}
        />
        Enable Copilot screen-reader optimizations
      </label>
      <button
        type="button"
        onClick={() => void window.copilotDesktopSettings
          .updateWorkspaceProfile(profile.id, name, permissionPreset, defaultResumeMode, launch)
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

function CopilotResourcesSettings({
  snapshot,
  onSaved,
  onMessage,
}: {
  snapshot: DesktopSettingsSnapshot
  onSaved: (snapshot: DesktopSettingsSnapshot) => void
  onMessage: (message: string) => void
}): JSX.Element {
  const [resourceName, setResourceName] = useState('')
  const [resourceKind, setResourceKind] = useState<CopilotResourceKind>('plugin')
  const [pluginSource, setPluginSource] = useState('')
  const [skillSource, setSkillSource] = useState('')
  const [projectSkill, setProjectSkill] = useState(true)
  const [mcpName, setMcpName] = useState('')
  const [mcpUrl, setMcpUrl] = useState('')
  const [mcpTransport, setMcpTransport] = useState<'http' | 'sse'>('http')
  const run = (operation: Promise<DesktopSettingsSnapshot>, success: string): void => {
    void operation.then((next) => {
      onSaved(next)
      onMessage(success)
    }).catch((error: unknown) => onMessage(error instanceof Error ? error.message : String(error)))
  }
  const mutate = (action: CopilotResourceAction): void => {
    if (action === 'remove' && !window.confirm(`Remove ${resourceKind} "${resourceName}" from Copilot?`)) return
    run(window.copilotDesktopSettings.mutateCopilotResource(action, resourceKind, resourceName), `Resource ${action} completed.`)
  }

  return (
    <section>
      <h2>Copilot extensions</h2>
      <p>Manage plugins, MCP servers, and skills discovered for the active workspace.</p>
      <div className="settings-actions">
        <button
          type="button"
          disabled={!snapshot.cliVersion || snapshot.resources.status === 'loading'}
          onClick={() => run(window.copilotDesktopSettings.refreshCopilotResources(), 'Copilot resources refreshed.')}
        >
          Refresh resources
        </button>
        <button
          type="button"
          onClick={() => void window.copilotDesktopSettings.openCopilotConfig()
            .catch((error: unknown) => onMessage(error instanceof Error ? error.message : String(error)))}
        >
          Open Copilot config folder
        </button>
      </div>
      <p>{snapshot.resources.message}</p>
      {snapshot.resources.output && <pre className="resource-output">{snapshot.resources.output}</pre>}

      <div className="settings-card">
        <strong>Enable, disable, or remove</strong>
        <div className="settings-form-grid">
          <label>
            Resource kind
            <select value={resourceKind} onChange={(event) => setResourceKind(event.target.value as CopilotResourceKind)}>
              <option value="plugin">Plugin</option>
              <option value="mcp">MCP server</option>
              <option value="skill">Skill</option>
            </select>
          </label>
          <label>
            Name
            <input type="text" value={resourceName} onChange={(event) => setResourceName(event.target.value)} />
          </label>
        </div>
        <div className="settings-actions">
          <button type="button" disabled={!resourceName} onClick={() => mutate('enable')}>Enable</button>
          <button type="button" disabled={!resourceName} onClick={() => mutate('disable')}>Disable</button>
          <button type="button" disabled={!resourceName} onClick={() => mutate('remove')}>Remove</button>
        </div>
      </div>

      <div className="settings-card">
        <strong>Install plugin or skill</strong>
        <div className="settings-form-grid">
          <label>
            Plugin source
            <input
              type="text"
              value={pluginSource}
              placeholder="marketplace spec, repository, URL, or local path"
              onChange={(event) => setPluginSource(event.target.value)}
            />
          </label>
          <div className="settings-field-action">
            <button
              type="button"
              disabled={!pluginSource}
              onClick={() => run(window.copilotDesktopSettings.installCopilotPlugin(pluginSource), 'Plugin installed.')}
            >Install plugin</button>
          </div>
          <label>
            Skill source
            <input
              type="text"
              value={skillSource}
              placeholder="file, URL, or directory"
              onChange={(event) => setSkillSource(event.target.value)}
            />
          </label>
          <div className="settings-field-action">
            <label className="settings-row">
              <input type="checkbox" checked={projectSkill} onChange={(event) => setProjectSkill(event.target.checked)} />
              Project scope
            </label>
            <button
              type="button"
              disabled={!skillSource}
              onClick={() => run(window.copilotDesktopSettings.installCopilotSkill(skillSource, projectSkill), 'Skill installed.')}
            >Install skill</button>
          </div>
        </div>
      </div>

      <div className="settings-card">
        <strong>Add remote MCP server</strong>
        <div className="settings-form-grid">
          <label>
            Server name
            <input type="text" value={mcpName} onChange={(event) => setMcpName(event.target.value)} />
          </label>
          <label>
            Transport
            <select value={mcpTransport} onChange={(event) => setMcpTransport(event.target.value as 'http' | 'sse')}>
              <option value="http">Streamable HTTP</option>
              <option value="sse">Server-sent events</option>
            </select>
          </label>
          <label className="settings-grid-wide">
            URL
            <input type="url" value={mcpUrl} onChange={(event) => setMcpUrl(event.target.value)} />
          </label>
        </div>
        <button
          type="button"
          disabled={!mcpName || !mcpUrl}
          onClick={() => run(window.copilotDesktopSettings.addCopilotMcp(mcpName, mcpUrl, mcpTransport), 'MCP server added.')}
        >Add MCP server</button>
      </div>
      <p className="settings-disclaimer">Custom agents, hooks, and LSP definitions can be supplied by installed plugins or edited in the Copilot configuration folder.</p>
    </section>
  )
}

export function SettingsApp(): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<DesktopSettingsSnapshot | null>(null)
  const [credentialDrafts, setCredentialDrafts] = useState<Record<string, string>>({})
  const [message, setMessage] = useState<string | null>(null)
  const [cliMaintenancePending, setCliMaintenancePending] = useState(false)

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
  const maintainCli = (operation: 'install' | 'update'): void => {
    setCliMaintenancePending(true)
    showMessage(operation === 'install' ? 'Installing Copilot CLI…' : 'Updating Copilot CLI…')
    const request = operation === 'install'
      ? window.copilotDesktopSettings.installCopilot()
      : window.copilotDesktopSettings.updateCopilot()
    void request
      .then(refresh)
      .catch((error: unknown) => showMessage(error instanceof Error ? error.message : String(error)))
      .finally(() => setCliMaintenancePending(false))
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

      <CopilotResourcesSettings snapshot={snapshot} onSaved={refresh} onMessage={showMessage} />

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
        <h2>Copilot CLI</h2>
        <p>Detected version: {snapshot.cliVersion ?? 'not installed'}</p>
        <p>{snapshot.cliMaintenance.message}</p>
        {snapshot.cliVersion && (
          <dl className="settings-definition-list">
            <div><dt>Session IDs and names</dt><dd>{snapshot.cliCapabilities.sessionIdentity ? 'Supported' : 'Unavailable'}</dd></div>
            <div><dt>Tool allowlists</dt><dd>{snapshot.cliCapabilities.toolAllowlist ? 'Supported' : 'Unavailable'}</dd></div>
            <div><dt>Launch profiles</dt><dd>{snapshot.cliCapabilities.launchProfiles ? 'Supported' : 'Unavailable'}</dd></div>
            <div><dt>Remote sessions</dt><dd>{snapshot.cliCapabilities.remoteSessions ? 'Supported' : 'Unavailable'}</dd></div>
            <div><dt>Plugins dashboard</dt><dd>{snapshot.cliCapabilities.plugins ? 'Supported' : 'Unavailable'}</dd></div>
            <div><dt>ACP</dt><dd>{snapshot.cliCapabilities.acp ? 'Supported (preview)' : 'Unavailable'}</dd></div>
          </dl>
        )}
        <div className="settings-actions">
          <button
            type="button"
            disabled={cliMaintenancePending || snapshot.cliMaintenance.status === 'running'}
            onClick={() => maintainCli('install')}
          >
            {snapshot.cliVersion ? 'Repair installation' : 'Install Copilot CLI'}
          </button>
          <button
            type="button"
            disabled={!snapshot.cliVersion || cliMaintenancePending || snapshot.cliMaintenance.status === 'running'}
            onClick={() => maintainCli('update')}
          >
            Update Copilot CLI
          </button>
          <button
            type="button"
            disabled={!snapshot.cliVersion || cliMaintenancePending || snapshot.cliMaintenance.status === 'running'}
            onClick={() => {
              showMessage('Rechecking Copilot CLI capabilities…')
              void window.copilotDesktopSettings.recheckCopilotCapabilities()
                .then((next) => {
                  refresh(next)
                  showMessage('Copilot CLI capabilities rechecked.')
                })
                .catch((error: unknown) => showMessage(error instanceof Error ? error.message : String(error)))
            }}
          >
            Recheck capabilities
          </button>
        </div>
        <p className="settings-disclaimer">Close active sessions before installing or updating the CLI.</p>
      </section>

      <section>
        <h2>Desktop updates</h2>
        <p>Desktop {snapshot.update.currentVersion}{snapshot.update.availableVersion ? ` · Available ${snapshot.update.availableVersion}` : ''}</p>
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
