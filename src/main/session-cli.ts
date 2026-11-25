// No imports: the renderer bundles this file for the new-session dialog, so it must not reach Node modules.

/** The CLI a session tab runs. Copilot CLI is the default and the only one the desktop integrates with in depth. */
export type SessionCli = 'copilot' | OtherCli
/** A CLI other than Copilot: its tab runs the CLI's own terminal interface. */
export type OtherCli = typeof OTHER_CLIS[number]

export const OTHER_CLIS = ['claude', 'codex', 'antigravity'] as const

/**
 * CLIs verified to act as temporary PR reviewers: Copilot (OS sandbox) plus Claude Code (`--restricted` + MCP)
 * and Codex CLI (`--sandbox read-only` + MCP), proven in `scripts/pr-temp-reviewers-spike.mjs`.
 * Antigravity is excluded in v1 because it shares a single global MCP config file without per-seat isolation.
 */
export const SUPPORTED_REVIEWER_CLIS = ['copilot', 'claude', 'codex'] as const
export type ReviewerCli = typeof SUPPORTED_REVIEWER_CLIS[number]
export const DEFAULT_REVIEWER_CLIS: readonly ReviewerCli[] = ['copilot']

export function isReviewerCli(value: unknown): value is ReviewerCli {
  return SUPPORTED_REVIEWER_CLIS.some((cli) => cli === value)
}

/**
 * Normalize a persisted reviewer CLI list. Malformed or unsupported entries are dropped, order follows
 * `SUPPORTED_REVIEWER_CLIS`, and an empty or missing value falls back to `fallback`.
 */
export function normalizeReviewerClis(
  value: unknown,
  fallback: readonly ReviewerCli[] = DEFAULT_REVIEWER_CLIS,
): ReviewerCli[] {
  if (!Array.isArray(value)) return [...fallback]
  const wanted = new Set<ReviewerCli>()
  for (const item of value) if (isReviewerCli(item)) wanted.add(item)
  if (wanted.size === 0) return [...fallback]
  return SUPPORTED_REVIEWER_CLIS.filter((cli) => wanted.has(cli))
}

/**
 * Validate a reviewer CLI list submitted from Settings: rejects non-arrays, unknown CLIs, or an empty selection
 * so a save never silently drops a user choice. `undefined` / `null` means "clear workspace override (inherit global)".
 */
export function validateReviewerClis(value: unknown, allowInherit = false): ReviewerCli[] | undefined {
  if (allowInherit && (value === undefined || value === null)) return undefined
  if (!Array.isArray(value)) throw new Error('Invalid PR reviewer CLIs')
  const wanted = new Set<ReviewerCli>()
  for (const item of value) {
    if (!isReviewerCli(item)) throw new Error(`Unsupported PR reviewer CLI "${String(item)}"`)
    wanted.add(item)
  }
  if (wanted.size === 0) throw new Error('Choose at least one CLI to act as a PR reviewer')
  return SUPPORTED_REVIEWER_CLIS.filter((cli) => wanted.has(cli))
}

const LABELS: Record<SessionCli, string> = {
  copilot: 'Copilot CLI',
  claude: 'Claude Code',
  codex: 'Codex CLI',
  antigravity: 'Antigravity CLI',
}

export function sessionCliLabel(cli: SessionCli | undefined): string {
  return LABELS[cli ?? 'copilot']
}

export function isOtherCli(value: unknown): value is OtherCli {
  return OTHER_CLIS.some((cli) => cli === value)
}

/**
 * How each CLI is updated. The desktop never updates them itself: each CLI's own command updates the copy it was installed
 * as, and an install made with a package manager is updated through that manager, as the vendor's page explains.
 */
export const OTHER_CLI_UPDATES: Record<OtherCli, { command: string; url: string }> = {
  claude: { command: 'claude update', url: 'https://code.claude.com/docs/en/setup#update-claude-code' },
  codex: { command: 'codex update', url: 'https://github.com/openai/codex#readme' },
  antigravity: { command: 'agy update', url: 'https://antigravity.google/docs/cli/troubleshooting/' },
}

/**
 * What the tabs running other CLIs started with, as one value that changes whenever such a tab starts, restarts with
 * another version or closes. Empty when no tab runs another CLI.
 */
export function otherCliLaunchKey(tabs: readonly { cli?: OtherCli; cliVersion: string | null }[]): string {
  return tabs.filter((tab) => tab.cli !== undefined).map((tab) => `${tab.cli}@${tab.cliVersion ?? ''}`).sort().join('\n')
}

/** What the new-session dialog shows for each CLI a tab can run: whether it was found, and how to get it when not. */
export interface SessionCliChoice {
  cli: SessionCli
  label: string
  version: string | null
  /** Why it cannot be started; null when it can. */
  error: string | null
}
