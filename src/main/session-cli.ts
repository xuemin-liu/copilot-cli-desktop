// No imports: the renderer bundles this file for the new-session dialog, so it must not reach Node modules.

/** The CLI a session tab runs. Copilot CLI is the default and the only one the desktop integrates with in depth. */
export type SessionCli = 'copilot' | OtherCli
/** A CLI other than Copilot: its tab runs the CLI's own terminal interface. */
export type OtherCli = typeof OTHER_CLIS[number]

export const OTHER_CLIS = ['claude', 'codex', 'antigravity'] as const

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

/** What the new-session dialog shows for each CLI a tab can run: whether it was found, and how to get it when not. */
export interface SessionCliChoice {
  cli: SessionCli
  label: string
  version: string | null
  /** Why it cannot be started; null when it can. */
  error: string | null
}
