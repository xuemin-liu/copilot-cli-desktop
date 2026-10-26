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
import type { CopilotUpdateChannel } from '../../main/copilot-auto-update.js'
import { UsageSettings } from './UsageSettings.js'
import { MigrationSettings } from './MigrationSettings.js'
import { MAX_WORKTREE_TIMEOUT_MINUTES } from '../../main/worktree-timeout.js'
import { MAX_MEETING_MAX_ROUNDS, MAX_MEETING_ROUND_TIMEOUT_MINUTES } from '../../main/meeting-settings.js'

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
        New sessions work in an isolated Git worktree by default (each new session can choose)
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
  const [capabilityCheckPending, setCapabilityCheckPending] = useState(false)
  const [cliAutoUpdatePending, setCliAutoUpdatePending] = useState(false)

  useEffect(() => {
    void window.copilotDesktopSettings.get().then(setSnapshot)
    const unsubscribeUpdate = window.copilotDesktopSettings.onUpdateStateChanged((update) => {
      setSnapshot((previous) => (previous ? { ...previous, update } : previous))
    })
    const unsubscribePreferences = window.copilotDesktopSettings.onPreferencesChanged((preferences) => {
      setSnapshot((previous) => (previous ? { ...previous, ...preferences } : previous))
    })
    const unsubscribeCopilotState = window.copilotDesktopSettings.onCopilotStateChanged((copilotState) => {
      setSnapshot((previous) => (previous ? { ...previous, ...copilotState } : previous))
    })
    return () => {
      unsubscribeUpdate()
      unsubscribePreferences()
      unsubscribeCopilotState()
    }
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
  const setCopilotAutoUpdate = (enabled: boolean, channel: CopilotUpdateChannel): void => {
    setCliAutoUpdatePending(true)
    void window.copilotDesktopSettings.setCopilotAutoUpdate(enabled, channel)
      .then((next) => {
        refresh(next)
        showMessage(`Copilot CLI automatic updates ${enabled ? `enabled on the ${channel} channel` : 'disabled'}.`)
      })
      .catch((error: unknown) => showMessage(error instanceof Error ? error.message : String(error)))
      .finally(() => setCliAutoUpdatePending(false))
  }
  // Send only the field(s) the user changed. Besides making rapid toggles
  // independent, this prevents an open Settings window from posting an old
  // close behavior over a newer choice remembered by the native close dialog.
  const updatePreference = (
    patch: Partial<Pick<
      DesktopSettingsSnapshot,
      'closeBehavior' | 'trayEnabled' | 'notifications' | 'automaticUpdateChecks' | 'globalShortcutEnabled' | 'browserProfile' | 'browserOverrides' | 'worktreeTimeoutMinutes' | 'worktreeCleanup' | 'meetingMaxRounds' | 'meetingRoundTimeoutMinutes'
    >>,
  ): void => {
    setSnapshot((previous) => {
      if (!previous) return previous
      const next = { ...previous, ...patch }
      void window.copilotDesktopSettings
        .updatePreferences(patch)
        .then(refresh)
      return next
    })
  }

  return (
    <div className="settings-app">
      {message && <div className="settings-toast">{message}</div>}

      <section>
        <h2>General</h2>
        <label className="settings-row settings-row-number">
          Worktree timeout (minutes)
          <input
            key={snapshot.worktreeTimeoutMinutes}
            type="number"
            min={1}
            max={MAX_WORKTREE_TIMEOUT_MINUTES}
            step={1}
            required
            defaultValue={snapshot.worktreeTimeoutMinutes}
            onBlur={(event) => {
              const input = event.currentTarget
              if (!input.reportValidity()) return
              const minutes = input.valueAsNumber
              if (minutes !== snapshot.worktreeTimeoutMinutes) updatePreference({ worktreeTimeoutMinutes: minutes })
            }}
          />
        </label>
        <p className="settings-disclaimer">
          Maximum time to create a new Git worktree. Default: 10 minutes. Changes apply to worktree creation started after saving.
        </p>
        <label className="settings-row settings-row-select">
          When a worktree session closes
          <select
            value={snapshot.worktreeCleanup}
            onChange={(event) => updatePreference({
              worktreeCleanup: event.target.value as DesktopSettingsSnapshot['worktreeCleanup'],
            })}
          >
            <option value="safe">Remove the worktree when nothing is lost</option>
            <option value="ask">Ask every time</option>
            <option value="keep">Keep the worktree</option>
          </select>
        </label>
        <p className="settings-disclaimer">
          Applies to the worktree the desktop created for a session, not to an existing worktree a session was started in.
          Nothing is lost when the worktree has no uncommitted changes: its branch is deleted too when every commit on it is
          also on another branch, and kept otherwise. A worktree with changes is removed only after you confirm, and goes to the Recycle
          Bin. Files Git ignores there (build output, node_modules) are deleted with it.
        </p>
        <label className="settings-row settings-row-number">
          Meeting round limit
          <input
            key={snapshot.meetingMaxRounds}
            type="number"
            min={1}
            max={MAX_MEETING_MAX_ROUNDS}
            step={1}
            required
            defaultValue={snapshot.meetingMaxRounds}
            onBlur={(event) => {
              const input = event.currentTarget
              if (!input.reportValidity()) return
              const rounds = input.valueAsNumber
              if (rounds !== snapshot.meetingMaxRounds) updatePreference({ meetingMaxRounds: rounds })
            }}
          />
        </label>
        <label className="settings-row settings-row-number">
          Meeting round timeout (minutes)
          <input
            key={snapshot.meetingRoundTimeoutMinutes}
            type="number"
            min={1}
            max={MAX_MEETING_ROUND_TIMEOUT_MINUTES}
            step={1}
            required
            defaultValue={snapshot.meetingRoundTimeoutMinutes}
            onBlur={(event) => {
              const input = event.currentTarget
              if (!input.reportValidity()) return
              const minutes = input.valueAsNumber
              if (minutes !== snapshot.meetingRoundTimeoutMinutes) updatePreference({ meetingRoundTimeoutMinutes: minutes })
            }}
          />
        </label>
        <p className="settings-disclaimer">
          A review meeting between sessions pauses after this many rounds and asks whether to go on. Default: 6 rounds. A round
          stops waiting for reviewers who have not replied after the timeout. Default: 10 minutes. Meetings already open keep their
          round limit.
        </p>
        <label className="settings-row settings-row-select">
          When the main window closes
          <select
            value={snapshot.closeBehavior}
            onChange={(event) => updatePreference({
              closeBehavior: event.target.value as DesktopSettingsSnapshot['closeBehavior'],
            })}
          >
            <option value="ask">Ask every time</option>
            <option value="tray">Minimize to tray</option>
            <option value="quit">Exit the application</option>
          </select>
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
        <h2>Session browser</h2>
        <label className="settings-row settings-row-select">
          Cookies, logins and site storage
          <select
            value={snapshot.browserProfile}
            onChange={(event) => updatePreference({
              browserProfile: event.target.value as DesktopSettingsSnapshot['browserProfile'],
            })}
          >
            <option value="separate">Separate for each session</option>
            <option value="shared">Shared by all sessions, like Chrome</option>
          </select>
        </label>
        <p className="settings-disclaimer">
          Separate keeps each session signed in on its own and clears its data when the session closes. Shared lets
          every session use the same logins, including the Copilot agent in each session, and keeps them when a session
          closes. Browsers already open keep their current profile until their session closes or the app restarts.
          History, site permissions and zoom are shared either way.
        </p>
        <label className="settings-row settings-row-select">
          DevTools settings and Local Overrides for new sessions
          <select
            value={snapshot.browserOverrides}
            onChange={(event) => updatePreference({
              browserOverrides: event.target.value as DesktopSettingsSnapshot['browserOverrides'],
            })}
          >
            <option value="shared">Shared by all sessions</option>
            <option value="private">Separate for each session</option>
          </select>
        </label>
        <p className="settings-disclaimer">
          Shared gives every session's DevTools the same Local Overrides folder, on/off switch and other DevTools settings, like
          one Chrome profile. Separate starts a session's DevTools with defaults and keeps its overrides folder and settings to
          that session; they are removed after it closes. This is the default in the new-session dialog, where each session can
          choose. Sessions already open keep what they started with. With shared cookies and logins, the Local Overrides
          on/off switch is shared too; the folder stays per session.
        </p>
        <div className="settings-actions">
          <button
            type="button"
            onClick={() => {
              if (!window.confirm('Sign every session out of the shared browser profile and remove its cookies, site storage and cache?')) return
              void window.copilotDesktopSettings.clearSharedBrowserData()
                .then(() => showMessage('Cleared shared browser data.'), (error: unknown) => showMessage(String(error)))
            }}
          >
            Clear shared browser data
          </button>
          <button
            type="button"
            onClick={() =>
              void window.copilotDesktopSettings.clearBrowserHistory()
                .then(() => showMessage('Cleared browsing history.'), (error: unknown) => showMessage(String(error)))
            }
          >
            Clear browsing history
          </button>
        </div>
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
          <div><dt>Configured startup permission</dt><dd>{snapshot.access.permissionLabel} ({snapshot.access.permissionSource})</dd></div>
          <div><dt>Windows process</dt><dd>{snapshot.access.elevation === 'administrator' ? 'Administrator' : snapshot.access.elevation === 'standard-user' ? 'Standard user' : 'Unknown'}</dd></div>
        </dl>
        {snapshot.access.warning && <p className="settings-warning">{snapshot.access.warning}</p>}
        <p className="settings-disclaimer">This setting is the startup default for newly created sessions. Existing sessions keep their own launch restrictions and Copilot approval mode across Restart and app restoration. It cannot remove rights already held by this Windows account — e.g. if the desktop app itself is running elevated, its Copilot sessions inherit administrator rights regardless of this preset.</p>
      </section>

      <ProviderSettings provider={snapshot.provider} onSaved={refresh} />
      <UsageSettings />
      <MigrationSettings onSaved={refresh} />

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
        <div className="settings-card">
          <label className="settings-row">
            <input
              type="checkbox"
              checked={snapshot.cliAutoUpdate.enabled}
              disabled={cliAutoUpdatePending || snapshot.cliAutoUpdate.error !== null}
              onChange={(event) => setCopilotAutoUpdate(event.target.checked, snapshot.cliAutoUpdate.channel)}
            />
            Automatically update Copilot CLI when a session starts
          </label>
          <label>
            Update channel
            <select
              value={snapshot.cliAutoUpdate.channel}
              disabled={cliAutoUpdatePending || snapshot.cliAutoUpdate.error !== null}
              onChange={(event) => setCopilotAutoUpdate(
                snapshot.cliAutoUpdate.enabled,
                event.target.value as CopilotUpdateChannel,
              )}
            >
              <option value="stable">Stable</option>
              <option value="prerelease">Prerelease</option>
            </select>
          </label>
          {snapshot.cliAutoUpdate.error && <p className="settings-warning">{snapshot.cliAutoUpdate.error}</p>}
          <p className="settings-disclaimer">
            Copilot updates at session start. Existing sessions keep their current CLI and are marked until restarted.
          </p>
        </div>
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
            disabled={cliMaintenancePending || capabilityCheckPending || snapshot.cliMaintenance.status === 'running'}
            onClick={() => maintainCli('install')}
          >
            {snapshot.cliVersion ? 'Repair installation' : 'Install Copilot CLI'}
          </button>
          <button
            type="button"
            disabled={!snapshot.cliVersion || cliMaintenancePending || capabilityCheckPending || snapshot.cliMaintenance.status === 'running'}
            onClick={() => maintainCli('update')}
          >
            Update Copilot CLI
          </button>
          <button
            type="button"
            disabled={!snapshot.cliVersion || cliMaintenancePending || capabilityCheckPending || snapshot.cliMaintenance.status === 'running'}
            onClick={() => {
              setCapabilityCheckPending(true)
              showMessage('Rechecking Copilot CLI capabilities…')
              void window.copilotDesktopSettings.recheckCopilotCapabilities()
                .then((next) => {
                  refresh(next)
                  showMessage('Copilot CLI capabilities rechecked.')
                })
                .catch((error: unknown) => showMessage(error instanceof Error ? error.message : String(error)))
                .finally(() => setCapabilityCheckPending(false))
            }}
          >
            {capabilityCheckPending ? 'Rechecking capabilities…' : 'Recheck capabilities'}
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
