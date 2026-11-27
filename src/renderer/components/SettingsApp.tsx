import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { CredentialName } from '../../main/secure-credentials.js'
import { PERMISSION_PRESET_INFO, PERMISSION_PRESETS, type PermissionPreset } from '../../main/permission-presets.js'
import type { ResumeMode } from '../../main/resume-args.js'
import type { DesktopSettingsSnapshot } from '../global.js'
import type { CopilotProviderConfig } from '../../main/provider-config.js'
import type { WorkspaceProfile } from '../../main/types.js'
import { REASONING_EFFORTS, type SessionLaunchConfig } from '../../main/session-launch.js'
import type { CliModelOption } from '../../main/cli-model-catalog.js'
import { AGENT_CLI_SETTINGS, otherCliReasoningEfforts, type OtherCliConfig } from '../../main/agent-cli-settings.js'
import { OTHER_CLIS, SESSION_CLIS, SUPPORTED_REVIEWER_CLIS, sessionCliLabel, type OtherCli, type ReviewerCli, type SessionCli } from '../../main/session-cli.js'
import type { CopilotResourceAction, CopilotResourceKind } from '../../main/copilot-resources.js'
import type { CopilotUpdateChannel } from '../../main/copilot-auto-update.js'
import { UsageSettings } from './UsageSettings.js'
import { MigrationSettings } from './MigrationSettings.js'
import { isMac, isWindows, TRASH_LABEL } from '../platform.js'
import { MAX_WORKTREE_TIMEOUT_MINUTES } from '../../main/worktree-timeout.js'
import { MAX_MEETING_MAX_ROUNDS, MAX_MEETING_ROUND_TIMEOUT_MINUTES } from '../../main/meeting-settings.js'
import { MAX_MAX_SESSION_TABS } from '../../main/session-tab-limit.js'
import { errorMessage } from '../errors.js'
import { matchesSearch, searchHits, searchTerms } from '../settings-search.js'

type NoticeKind = 'success' | 'error' | 'info'
type Notify = (text: string, kind?: NoticeKind) => void
/** Runs a settings save, applies the returned snapshot, and reports success or the error. */
type Save = (operation: Promise<DesktopSettingsSnapshot>, success: string, failure?: string) => Promise<void>

const SEARCH_HIGHLIGHT = 'settings-search'

/** What a search can find in a section: its text (including closed <select> options) plus field placeholders and labels. */
function searchableText(section: HTMLElement): string {
  const attributes = Array.from(section.querySelectorAll('[placeholder], [aria-label]'), (element) =>
    `${element.getAttribute('placeholder') ?? ''} ${element.getAttribute('aria-label') ?? ''}`)
  return `${section.textContent ?? ''} ${attributes.join(' ')}`
}

/** Marks matches with the CSS Custom Highlight API, which styles text without changing the DOM React owns. */
function highlightMatches(sections: HTMLElement[], terms: readonly string[]): void {
  if (typeof Highlight === 'undefined' || !('highlights' in CSS)) return
  CSS.highlights.delete(SEARCH_HIGHLIGHT)
  if (terms.length === 0) return
  const ranges: Range[] = []
  for (const section of sections) {
    const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => node.parentElement?.closest('option, script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    })
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0
      for (const hit of searchHits(node.textContent ?? '', terms)) {
        if (hit.end > length) continue
        const range = document.createRange()
        range.setStart(node, hit.start)
        range.setEnd(node, hit.end)
        ranges.push(range)
      }
    }
  }
  CSS.highlights.set(SEARCH_HIGHLIGHT, new Highlight(...ranges))
}

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

type ModelCatalogs = Partial<Record<SessionCli, CliModelOption[]>>

const effortLabels: Record<string, string> = {
  none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high',
  max: 'Maximum', ultra: 'Ultra', ultracode: 'Ultracode',
}
const COPILOT_EFFORTS = REASONING_EFFORTS.filter((effort) => effort !== 'default')
const CUSTOM_MODEL = '--custom-model'

type ModelEffort = { model?: string; reasoningEffort?: string }

function sameModelEffort(left: ModelEffort | undefined, right: ModelEffort | undefined): boolean {
  return left?.model === right?.model && left?.reasoningEffort === right?.reasoningEffort
}

function acceptsNewModelEffort(
  catalog: CliModelOption[] | undefined,
  choice: ModelEffort,
  saved: ModelEffort | undefined,
): boolean {
  const effort = choice.reasoningEffort
  if (!effort || effort === 'default' || sameModelEffort(choice, saved)) return true
  const levels = catalog?.find((model) => model.id === choice.model?.trim())?.efforts
  return levels === undefined || levels.includes(effort)
}

function ModelFields({ label, catalog, model, effort, fallbackEfforts = [], onChange }: {
  label: string
  catalog: CliModelOption[] | undefined
  model: string
  effort?: string
  fallbackEfforts?: readonly string[]
  onChange: (model: string, effort: string) => void
}): JSX.Element {
  const [custom, setCustom] = useState(false)
  const selected = catalog?.find((entry) => entry.id === model)
  const selectedEfforts = selected?.efforts ?? fallbackEfforts
  const chooseModel = (next: string): void => {
    const levels = catalog?.find((entry) => entry.id === next)?.efforts ?? fallbackEfforts
    onChange(next, effort && levels.includes(effort) ? effort : '')
  }
  return <>
    <label>
      {label}
      <select value={custom ? CUSTOM_MODEL : model} onChange={(event) => {
        const next = event.target.value
        setCustom(next === CUSTOM_MODEL)
        if (next !== CUSTOM_MODEL) chooseModel(next)
      }}>
        <option value="">Use CLI default</option>
        {model && !selected && !custom && <option value={model}>{model} (saved)</option>}
        {catalog?.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        <option value={CUSTOM_MODEL}>Custom model…</option>
      </select>
      {!catalog?.length && <small role="status">{catalog ? 'Model list unavailable' : 'Loading models…'}</small>}
    </label>
    {custom && (
      <label>
        Custom model ID
        <input
          type="text"
          value={model}
          maxLength={200}
          onChange={(event) => onChange(event.target.value, effort ?? '')}
        />
      </label>
    )}
    {effort !== undefined && (
      <label>
        Reasoning effort
        <select value={effort} disabled={!effort && selectedEfforts.length === 0} onChange={(event) => onChange(model, event.target.value)}>
          <option value="">Model default</option>
          {effort && !selectedEfforts.includes(effort) && <option value={effort}>{effortLabels[effort] ?? effort} (saved)</option>}
          {selectedEfforts.map((level) => <option key={level} value={level}>{effortLabels[level] ?? level}</option>)}
        </select>
      </label>
    )}
  </>
}

function WorkspaceProfileEditor({
  profile,
  active,
  defaultReviewerClis,
  modelCatalogs,
  onSave,
}: {
  profile: WorkspaceProfile
  active: boolean
  defaultReviewerClis: readonly ReviewerCli[]
  modelCatalogs: ModelCatalogs
  onSave: Save
}): JSX.Element {
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState(profile.name)
  const [permissionPreset, setPermissionPreset] = useState(profile.permissionPreset)
  const [defaultResumeMode, setDefaultResumeMode] = useState(profile.defaultResumeMode)
  const [launch, setLaunch] = useState<SessionLaunchConfig>(profile.launch)
  const [otherCli, setOtherCli] = useState<OtherCliConfig>(profile.otherCli ?? {})
  const [reviewerOverride, setReviewerOverride] = useState<ReviewerCli[] | null>(profile.reviewerClis ? [...profile.reviewerClis] : null)
  const [activeCli, setActiveCli] = useState<OtherCli>(OTHER_CLIS[0])

  const nullableNumber = (value: string): number | null => value === '' ? null : Number(value)

  const setOtherCliFields = (cli: OtherCli, fields: Record<string, string>): void => setOtherCli((current) => {
    const next = { ...current }
    const perCli = { ...(next[cli] ?? {}) }
    for (const [key, value] of Object.entries(fields)) {
      if (value) perCli[key] = value
      else delete perCli[key]
    }
    if (Object.keys(perCli).length === 0) delete next[cli]
    else next[cli] = perCli
    return next
  })
  const activeDescriptor = AGENT_CLI_SETTINGS[activeCli]
  const activeConfig = otherCli[activeCli] ?? {}

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
        <ModelFields
          label="Initial model"
          catalog={modelCatalogs.copilot}
          model={launch.model}
          effort={launch.reasoningEffort === 'default' ? '' : launch.reasoningEffort}
          fallbackEfforts={COPILOT_EFFORTS}
          onChange={(model, effort) => setLaunch((current) => ({
            ...current, model, reasoningEffort: (effort || 'default') as SessionLaunchConfig['reasoningEffort'],
          }))}
        />
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
      <div className="other-cli-settings">
        <div className="other-cli-heading">
          <strong>Other CLIs</strong>
          <span>Permission and model for sessions this workspace starts with another CLI. Each setting defaults to the CLI&rsquo;s own; changes apply to new sessions.</span>
        </div>
        <div className="other-cli-tabs" role="tablist" aria-label="CLI">
          {OTHER_CLIS.map((cli) => {
            const configured = Object.keys(otherCli[cli] ?? {}).length > 0
            return (
              <button
                key={cli}
                type="button"
                role="tab"
                aria-selected={activeCli === cli}
                className={`other-cli-tab${activeCli === cli ? ' other-cli-tab-active' : ''}`}
                onClick={() => setActiveCli(cli)}
              >
                {sessionCliLabel(cli)}{configured ? ' •' : ''}
              </button>
            )
          })}
        </div>
        <div className="settings-form-grid">
          {activeDescriptor.selectors.map((selector) => {
            const sandboxBypassed = activeCli === 'codex' && selector.key === 'sandbox' && activeConfig.approval === 'allow-all'
            return (
              <label key={selector.key}>
                {selector.label}
                <select
                  value={activeConfig[selector.key] ?? ''}
                  disabled={sandboxBypassed}
                  title={sandboxBypassed ? 'Bypassed when Approval is set to Allow all' : undefined}
                onChange={(event) => setOtherCliFields(activeCli, { [selector.key]: event.target.value })}
                >
                  <option value="">{selector.inheritLabel}</option>
                  {selector.levels.map((level) => (
                    <option key={level.value} value={level.value}>{level.label}</option>
                  ))}
                  {activeConfig[selector.key] && !selector.levels.some((level) => level.value === activeConfig[selector.key]) && (
                    <option value={activeConfig[selector.key]}>{activeConfig[selector.key]} (not supported — choose another)</option>
                  )}
                </select>
              </label>
            )
          })}
          <ModelFields
            key={activeCli}
            label={activeCli === 'antigravity' ? 'Model and thinking' : 'Model'}
            catalog={modelCatalogs[activeCli]}
            model={activeConfig.model ?? ''}
            fallbackEfforts={otherCliReasoningEfforts(activeCli)}
            {...(activeCli === 'antigravity' ? {} : { effort: activeConfig.reasoningEffort ?? '' })}
            onChange={(model, effort) => setOtherCliFields(activeCli, { model, reasoningEffort: effort })}
          />
        </div>
        {activeDescriptor.permissionNote && <p className="settings-disclaimer">{activeDescriptor.permissionNote}</p>}
      </div>
      <div className="other-cli-settings">
        <div className="other-cli-heading">
          <strong>Hidden reviewer CLIs</strong>
          <span>Which CLIs start hidden reviewer sessions when <code>review-and-fix-pr</code> or <code>review-meeting</code> runs in this workspace.</span>
        </div>
        <label className="settings-row">
          <input
            type="checkbox"
            checked={reviewerOverride === null}
            onChange={(event) => setReviewerOverride(event.target.checked ? null : [...defaultReviewerClis])}
          />
          Use default reviewer CLIs ({defaultReviewerClis.map((cli) => sessionCliLabel(cli)).join(', ')})
        </label>
        {reviewerOverride !== null && (
          <div className="settings-form-grid" role="group" aria-label={`Reviewer CLIs for ${profile.name}`}>
            {SUPPORTED_REVIEWER_CLIS.map((cli) => {
              const checked = reviewerOverride.includes(cli)
              return (
                <label key={cli} className="settings-row">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={checked && reviewerOverride.length <= 1}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? SUPPORTED_REVIEWER_CLIS.filter((item) => item === cli || reviewerOverride.includes(item))
                        : reviewerOverride.filter((item) => item !== cli)
                      if (next.length > 0) setReviewerOverride(next)
                    }}
                  />
                  {sessionCliLabel(cli)}
                </label>
              )
            })}
          </div>
        )}
      </div>
      <div className="settings-actions">
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            const nextLaunch: SessionLaunchConfig = acceptsNewModelEffort(modelCatalogs.copilot, launch, profile.launch)
              ? launch : { ...launch, reasoningEffort: 'default' }
            const nextOtherCli = { ...otherCli }
            const clearedEfforts: OtherCli[] = []
            for (const cli of OTHER_CLIS) {
              const config = otherCli[cli]
              if (config && !acceptsNewModelEffort(modelCatalogs[cli], config, profile.otherCli?.[cli])) {
                const { reasoningEffort: _effort, ...remaining } = config
                nextOtherCli[cli] = remaining
                clearedEfforts.push(cli)
              }
            }
            setSaving(true)
            void onSave(
              window.copilotDesktopSettings.updateWorkspaceProfile(
                profile.id,
                name,
                permissionPreset,
                defaultResumeMode,
                nextLaunch,
                Object.keys(nextOtherCli).length > 0 ? nextOtherCli : undefined,
                reviewerOverride ?? undefined,
              ).then((next) => {
                if (nextLaunch !== launch) {
                  setLaunch((current) => sameModelEffort(current, launch)
                    ? { ...current, reasoningEffort: nextLaunch.reasoningEffort }
                    : current)
                }
                if (clearedEfforts.length > 0) {
                  setOtherCli((current) => {
                    const updated = { ...current }
                    for (const cli of clearedEfforts) {
                      const config = current[cli]
                      if (config && sameModelEffort(config, otherCli[cli])) {
                        const { reasoningEffort: _effort, ...remaining } = config
                        updated[cli] = remaining
                      }
                    }
                    return updated
                  })
                }
                return next
              }),
              `Saved profile "${name.trim() || profile.name}".`,
              `Could not save profile "${profile.name}"`,
            ).finally(() => setSaving(false))
          }}
        >
          {saving ? 'Saving…' : 'Save profile'}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            if (!window.confirm(`Remove the workspace "${profile.name}" from Copilot CLI Desktop?

Its project folder and files are not changed. Saved SSH connections, terminal preferences and default terminal logs for this workspace will be deleted. Logs in a custom folder are kept. Add the workspace again any time.`)) return
            setSaving(true)
            void onSave(
              window.copilotDesktopSettings.removeWorkspaceProfile(profile.id),
              `Removed workspace "${profile.name}".`,
              `Could not remove workspace "${profile.name}"`,
            ).finally(() => setSaving(false))
          }}
        >
          Remove workspace
        </button>
      </div>
    </div>
  )
}

function ProviderSettings({
  provider,
  onSave,
}: {
  provider: CopilotProviderConfig
  onSave: Save
}): JSX.Element {
  const [saving, setSaving] = useState(false)
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
      <button
        type="button"
        disabled={saving}
        onClick={() => {
          setSaving(true)
          void onSave(
            window.copilotDesktopSettings.updateProvider(draft),
            'Saved model provider. New sessions will use it.',
            'Could not save the model provider',
          ).finally(() => setSaving(false))
        }}
      >
        {saving ? 'Saving…' : 'Save provider'}
      </button>
      <p className="settings-disclaimer">Provider changes apply to new Copilot sessions.</p>
    </section>
  )
}

function CopilotResourcesSettings({
  snapshot,
  onSaved,
  notify,
}: {
  snapshot: DesktopSettingsSnapshot
  onSaved: (snapshot: DesktopSettingsSnapshot) => void
  notify: Notify
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
      notify(success)
    }).catch((error: unknown) => notify(errorMessage(error), 'error'))
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
            .catch((error: unknown) => notify(errorMessage(error), 'error'))}
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
  const [modelCatalogs, setModelCatalogs] = useState<ModelCatalogs>({})
  const [catalogRefresh, setCatalogRefresh] = useState(0)
  const lastCatalogRefresh = useRef(0)
  const providerKey = snapshot ? JSON.stringify([snapshot.provider, snapshot.copilotModelCatalogRevision]) : null
  const [credentialDrafts, setCredentialDrafts] = useState<Record<string, string>>({})
  const [cliMaintenancePending, setCliMaintenancePending] = useState(false)
  const [capabilityCheckPending, setCapabilityCheckPending] = useState(false)
  const [cliAutoUpdatePending, setCliAutoUpdatePending] = useState(false)
  const [notice, setNotice] = useState<{ text: string; kind: NoticeKind } | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [visibleSections, setVisibleSections] = useState<Array<{ element: HTMLElement; title: string }>>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const terms = searchTerms(query)

  // Filtering reads the rendered text instead of a hand-kept keyword list, so a new
  // setting is findable by its label, help text and option names without extra work.
  useLayoutEffect(() => {
    const content = scrollRef.current
    if (!content) return
    const sections = Array.from(content.querySelectorAll<HTMLElement>(':scope > section'))
    const visible: HTMLElement[] = []
    for (const section of sections) {
      section.hidden = !matchesSearch(searchableText(section), terms)
      if (!section.hidden) visible.push(section)
    }
    highlightMatches(visible, terms)
    setVisibleSections(visible.map((element) => ({
      element,
      title: element.querySelector('h2')?.textContent ?? '',
    })))
  }, [query, snapshot, modelCatalogs])

  useEffect(() => {
    if (providerKey === null) return
    const reload = lastCatalogRefresh.current !== catalogRefresh
    lastCatalogRefresh.current = catalogRefresh
    setModelCatalogs({})
    let active = true
    for (const cli of SESSION_CLIS) {
      void window.copilotDesktopSettings.getModelCatalog(cli, reload)
        .catch(() => [])
        .then((catalog) => {
          if (active) setModelCatalogs((current) => ({ ...current, [cli]: catalog }))
        })
    }
    return () => { active = false }
  }, [catalogRefresh, providerKey])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [query])

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', focusSearch)
    return () => {
      window.removeEventListener('keydown', focusSearch)
      clearTimeout(noticeTimer.current)
      if ('highlights' in CSS) CSS.highlights.delete(SEARCH_HIGHLIGHT)
    }
  }, [])

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
  // Errors stay up longer than confirmations so there is time to read them.
  const notify: Notify = (text, kind = 'success') => {
    clearTimeout(noticeTimer.current)
    setNotice({ text, kind })
    noticeTimer.current = setTimeout(() => setNotice(null), kind === 'error' ? 10_000 : 3_000)
  }
  const notifyError = (error: unknown, context?: string): void =>
    notify(context ? `${context}: ${errorMessage(error)}` : errorMessage(error), 'error')
  const save: Save = (operation, success, failure = 'Could not save') => operation.then(
    (next) => {
      refresh(next)
      notify(success)
    },
    (error: unknown) => notifyError(error, failure),
  )
  const maintainCli = (operation: 'install' | 'update'): void => {
    setCliMaintenancePending(true)
    notify(operation === 'install' ? 'Installing Copilot CLI…' : 'Updating Copilot CLI…', 'info')
    const request = operation === 'install'
      ? window.copilotDesktopSettings.installCopilot()
      : window.copilotDesktopSettings.updateCopilot()
    void request
      .then(refresh)
      .catch((error: unknown) => notifyError(error))
      .finally(() => setCliMaintenancePending(false))
  }
  const setCopilotAutoUpdate = (enabled: boolean, channel: CopilotUpdateChannel): void => {
    setCliAutoUpdatePending(true)
    void save(
      window.copilotDesktopSettings.setCopilotAutoUpdate(enabled, channel),
      `Copilot CLI automatic updates ${enabled ? `enabled on the ${channel} channel` : 'disabled'}.`,
      'Could not change Copilot CLI automatic updates',
    ).finally(() => setCliAutoUpdatePending(false))
  }
  // Send only the field(s) the user changed. Besides making rapid toggles
  // independent, this prevents an open Settings window from posting an old
  // close behavior over a newer choice remembered by the native close dialog.
  const updatePreference = (
    patch: Partial<Pick<
      DesktopSettingsSnapshot,
      'closeBehavior' | 'trayEnabled' | 'notifications' | 'automaticUpdateChecks' | 'globalShortcutEnabled' | 'browserProfile' | 'browserOverrides' | 'worktreeTimeoutMinutes' | 'worktreeCleanup' | 'meetingMaxRounds' | 'meetingRoundTimeoutMinutes' | 'meetingDiscussion' | 'maxSessionTabs' | 'desktopControl' | 'openFilesOutsideWorkspace' | 'turnCheckpoints' | 'reviewerClis' | 'reviewerAllowAll'
    >>,
  ): void => {
    setSnapshot((previous) => (previous ? { ...previous, ...patch } : previous))
    void window.copilotDesktopSettings
      .updatePreferences(patch)
      .then((next) => {
        refresh(next)
        notify('Setting saved.')
      })
      .catch((error: unknown) => {
        notifyError(error, 'Setting not saved')
        // Drop the optimistic value so the control shows what is really stored.
        void window.copilotDesktopSettings.get().then(refresh)
      })
  }

  return (
    <div className="settings-app" ref={scrollRef}>
      <header className="settings-search-bar">
        <input
          ref={searchRef}
          type="search"
          className="settings-search"
          value={query}
          placeholder="Search settings"
          aria-label="Search settings"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.preventDefault()
              setQuery('')
            }
          }}
        />
        <nav className="settings-nav" aria-label="Settings sections">
          {visibleSections.map(({ element, title }) => (
            <button key={title} type="button" onClick={() => element.scrollIntoView({ block: 'start' })}>{title}</button>
          ))}
        </nav>
      </header>

      {terms.length > 0 && visibleSections.length === 0 && (
        <p className="settings-search-empty">No settings match "{query.trim()}".</p>
      )}

      <section>
        <h2>Window and startup</h2>
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
            onChange={(event) => {
              const enabled = event.target.checked
              void save(
                window.copilotDesktopSettings.setLaunchAtLogin(enabled),
                enabled ? 'Copilot CLI Desktop will launch at sign-in.' : 'Launch at sign-in turned off.',
                'Could not change launch at sign-in',
              )
            }}
          />
          Launch at sign-in{!snapshot.launchAtLoginAvailable ? ' (installed builds only)' : ''}
        </label>
        <label className="settings-row settings-row-number">
          Most session tabs open at once
          <input
            key={snapshot.maxSessionTabs}
            type="number"
            min={1}
            max={MAX_MAX_SESSION_TABS}
            step={1}
            required
            defaultValue={snapshot.maxSessionTabs}
            onBlur={(event) => {
              const input = event.currentTarget
              if (!input.reportValidity()) return
              const tabs = input.valueAsNumber
              if (tabs !== snapshot.maxSessionTabs) updatePreference({ maxSessionTabs: tabs })
            }}
          />
        </label>
        <p className="settings-disclaimer">
          Default 20. Saved and unloaded tabs count too. Lowering it closes nothing: tabs already open stay until you close them.
        </p>
      </section>

      <section>
        <h2>Worktrees</h2>
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
          also on another branch, and kept otherwise. A worktree with changes is removed only after you confirm, and goes to the
          {' '}{TRASH_LABEL}. Files Git ignores there (build output, node_modules) are deleted with it.
        </p>
      </section>

      <section>
        <h2>Review meetings</h2>
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
        <label className="settings-row">
          <input
            type="checkbox"
            checked={snapshot.meetingDiscussion}
            onChange={(event) => updatePreference({ meetingDiscussion: event.target.checked })}
          />
          Let meeting reviewers answer each other before the host replies
        </label>
        <p className="settings-disclaimer">
          With two or more reviewers, each one reads the others' replies to a round and answers them in one more turn; the host
          then gets the reviews and that discussion together. It costs one more turn per reviewer per round. Votes are not
          discussed. Off by default.
        </p>
      </section>

      <section>
        <h2>Reviewers</h2>
        <div role="group" aria-label="Default reviewer CLIs">
          {SUPPORTED_REVIEWER_CLIS.map((cli) => {
            const checked = snapshot.reviewerClis.includes(cli)
            return (
              <label key={cli} className="settings-row">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={checked && snapshot.reviewerClis.length <= 1}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? SUPPORTED_REVIEWER_CLIS.filter((item) => item === cli || snapshot.reviewerClis.includes(item))
                      : snapshot.reviewerClis.filter((item) => item !== cli)
                    if (next.length > 0) updatePreference({ reviewerClis: next })
                  }}
                />
                {sessionCliLabel(cli)}
              </label>
            )
          })}
        </div>
        <label className="settings-row">
          <input
            type="checkbox"
            checked={snapshot.reviewerAllowAll}
            onChange={(event) => updatePreference({ reviewerAllowAll: event.target.checked })}
          />
          Allow all permissions in hidden reviewer sessions
        </label>
        <p className="settings-disclaimer">
          Default CLIs launched as hidden reviewer sessions, for a pull request when <code>review-and-fix-pr</code> runs and for a
          review meeting when <code>review-meeting</code> runs (each workspace profile can override which CLIs run). For a pull
          request each reviewer runs <code>review-pr</code> in an isolated detached Git worktree and posts its comments and
          approvals directly onto the pull request; for a meeting each joins the meeting from a detached checkout of the
          project&rsquo;s last commit, and you are asked before they start. Keeping &ldquo;Allow all permissions&rdquo; enabled
          launches hidden reviewers with <code>--allow-all</code> (Copilot CLI), <code>--dangerously-skip-permissions</code>{' '}
          (Claude Code and Antigravity CLI), and <code>--dangerously-bypass-approvals-and-sandbox</code> (Codex CLI) so background
          reviews do not stall on terminal prompts.
        </p>
      </section>

      <section>
        <h2>Desktop control</h2>
        <label className="settings-row">
          <input
            type="checkbox"
            checked={snapshot.desktopControl}
            disabled={!isWindows}
            onChange={(event) => updatePreference({ desktopControl: event.target.checked })}
          />
          Let sessions request desktop control
        </label>
        <p className="settings-disclaimer">
          {isWindows ? '' : 'Desktop control is available on Windows only. '}
          New sessions ask when they first need desktop access. You can allow one action, allow access for the session,
          or turn it on from the session toolbar. Copilot sees and uses only apps you approve. It can never control this app, terminals,
          File Explorer, Start, sign-in or password windows, or administrator windows, and it never types into password fields.
          A banner shows while it is on, and Ctrl+Alt+Shift+X stops it anywhere. Turning this off turns desktop control off in
          every session. Off by default.
        </p>
      </section>

      <section>
        <h2>File links</h2>
        <label className="settings-row">
          <input
            type="checkbox"
            checked={snapshot.openFilesOutsideWorkspace}
            onChange={(event) => updatePreference({ openFilesOutsideWorkspace: event.target.checked })}
          />
          Open files outside the workspace
        </label>
        <p className="settings-disclaimer">
          A file path you click in a session terminal, a File tab or the Git panel opens in a File tab only when it is inside
          that workspace or one of its worktrees. Turn this on to open any file on this computer the same way, read only. Turning
          it off again also stops File tabs already showing such files from reading them. Off by default.
        </p>
      </section>

      <section>
        <h2>Turn checkpoints</h2>
        <label className="settings-row">
          <input
            type="checkbox"
            checked={snapshot.turnCheckpoints}
            onChange={(event) => updatePreference({ turnCheckpoints: event.target.checked })}
          />
          Snapshot the working folder at each turn
        </label>
        <p className="settings-disclaimer">
          When you send a prompt in a Copilot session, and again when Copilot finishes, the files in its Git repository are
          snapshotted so that the changes of each turn can be shown. Snapshots are kept in this app's data folder: nothing is
          written to your repository. Ignored files, links, files over 25 MB and submodules are left out, and old snapshots
          are removed by themselves. Turning this off deletes every snapshot. On by default.
        </p>
      </section>

      <section>
        <h2>Project browsers</h2>
        <label className="settings-row settings-row-select">
          Cookies, logins and site storage
          <select
            value={snapshot.browserProfile}
            onChange={(event) => updatePreference({
              browserProfile: event.target.value as DesktopSettingsSnapshot['browserProfile'],
            })}
          >
            <option value="separate">Separate for each project</option>
            <option value="shared">Shared by all projects, like Chrome</option>
          </select>
        </label>
        <p className="settings-disclaimer">
          Separate gives each project its own cookies and site storage. Closing tabs or CLI sessions keeps your logins.
          Removing a workspace forgets its private browser profile, so adding it again starts with fresh logins; its
          cookies and site storage are deleted at the next app start, or later while a settings recovery is pending.
          Shared uses one profile across projects. Open browsers keep their profile until all their project's pages close or the app restarts.
          History, site permissions and zoom are shared either way.
        </p>
        <label className="settings-row settings-row-select">
          Default Local Overrides for new project browsers
          <select
            value={snapshot.browserOverrides}
            onChange={(event) => updatePreference({
              browserOverrides: event.target.value as DesktopSettingsSnapshot['browserOverrides'],
            })}
          >
            <option value="shared">Shared settings</option>
            <option value="private">Separate for each project</option>
          </select>
        </label>
        <p className="settings-disclaimer">
          Each project remembers its Local Overrides choice in Browser settings. Private keeps that project's DevTools
          settings and folders separate. Shared uses common defaults. Changes to a project's choice apply after all its
          browser tabs close and a new Browser opens. With shared cookies, the overrides switch is also shared.
        </p>
        <div className="settings-actions">
          <button
            type="button"
            onClick={() => {
              if (!window.confirm('Sign every project out of the shared browser profile and remove its cookies, site storage and cache?')) return
              void window.copilotDesktopSettings.clearSharedBrowserData()
                .then(() => notify('Cleared shared browser data.'), (error: unknown) => notifyError(error, 'Could not clear shared browser data'))
            }}
          >
            Clear shared browser data
          </button>
          <button
            type="button"
            onClick={() =>
              void window.copilotDesktopSettings.clearBrowserHistory()
                .then(() => notify('Cleared browsing history.'), (error: unknown) => notifyError(error, 'Could not clear browsing history'))
            }
          >
            Clear browsing history
          </button>
        </div>
      </section>

      <section>
        <h2>Workspace profiles</h2>
        {snapshot.profiles.length === 0 && <p>No workspaces yet. Choose one from the main window.</p>}
        {snapshot.profiles.length > 0 && (
          <div className="settings-actions">
            <button type="button" disabled={SESSION_CLIS.some((cli) => !modelCatalogs[cli])} onClick={() => setCatalogRefresh((current) => current + 1)}>Refresh models</button>
          </div>
        )}
        {snapshot.profiles.map((profile) => (
          <WorkspaceProfileEditor
            key={profile.id}
            profile={profile}
            active={profile.id === snapshot.activeProfileId}
            defaultReviewerClis={snapshot.reviewerClis}
            modelCatalogs={modelCatalogs}
            onSave={save}
          />
        ))}
      </section>

      <section>
        <h2>Access status</h2>
        <dl className="settings-definition-list">
          <div><dt>Configured startup permission</dt><dd>{snapshot.access.permissionLabel} ({snapshot.access.permissionSource})</dd></div>
          <div><dt>{isWindows ? 'Windows process' : 'Desktop process'}</dt><dd>{snapshot.access.elevation === 'administrator' ? 'Administrator' : snapshot.access.elevation === 'standard-user' ? 'Standard user' : 'Unknown'}</dd></div>
        </dl>
        {snapshot.access.warning && <p className="settings-warning">{snapshot.access.warning}</p>}
        <p className="settings-disclaimer">This setting is the startup default for newly created sessions. Existing sessions keep their own launch restrictions and Copilot approval mode across Restart and app restoration. It cannot remove rights already held by this Windows account — e.g. if the desktop app itself is running elevated, its Copilot sessions inherit administrator rights regardless of this preset.</p>
      </section>

      <ProviderSettings provider={snapshot.provider} onSave={save} />
      <UsageSettings />
      {/* Migration moves a setup between Windows computers only. */}
      {isWindows && <MigrationSettings onSaved={refresh} />}

      <CopilotResourcesSettings snapshot={snapshot} onSaved={refresh} notify={notify} />

      <section>
        <h2>Protected credential vault</h2>
        <p>
          Values are encrypted with {isWindows ? 'Windows DPAPI' : isMac ? 'the macOS Keychain' : 'your keyring (libsecret or KWallet)'} via Electron <code>safeStorage</code> and injected only into
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
                  notify(`Saved ${entry.name}.`)
                }, (error: unknown) => notifyError(error, `Could not save ${entry.name}`))
              }
            >
              Save
            </button>
            <button
              type="button"
              disabled={!entry.configured || entry.source !== 'protected-store'}
              onClick={() => void save(
                window.copilotDesktopSettings.deleteCredential(entry.name),
                `Removed ${entry.name}.`,
                `Could not remove ${entry.name}`,
              )}
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
              notify('Rechecking Copilot CLI capabilities…', 'info')
              void save(
                window.copilotDesktopSettings.recheckCopilotCapabilities(),
                'Copilot CLI capabilities rechecked.',
                'Could not recheck Copilot CLI capabilities',
              ).finally(() => setCapabilityCheckPending(false))
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
            onClick={() => void window.copilotDesktopSettings.checkForUpdates()
              .then(refresh, (error: unknown) => notifyError(error, 'Could not check for updates'))}
          >
            Check for updates
          </button>
          <button
            type="button"
            disabled={!snapshot.update.canDownload}
            onClick={() => void window.copilotDesktopSettings.downloadUpdate()
              .then(refresh, (error: unknown) => notifyError(error, 'Could not download the update'))}
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

      {notice && (
        <div className={`settings-toast settings-toast-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
          <span>{notice.text}</span>
          <button type="button" aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button>
        </div>
      )}

      <p className="settings-disclaimer">
        Copilot CLI Desktop is an unofficial, community-built wrapper around the public <code>copilot</code> CLI.
        It is not affiliated with, endorsed by, or supported by GitHub or Microsoft.
      </p>
    </div>
  )
}
