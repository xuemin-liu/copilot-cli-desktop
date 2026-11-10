// No imports: the renderer bundles this file for the new-session dialog, so it must not reach Node modules.

/** The CLI a session tab runs. Copilot CLI is the default and the only one the desktop integrates with in depth. */
export type SessionCli = 'copilot' | 'claude' | 'codex'
/** A CLI other than Copilot: its tab is a terminal for it, in the project folder, resumed by its own session id. */
export type OtherCli = Exclude<SessionCli, 'copilot'>

export const OTHER_CLIS: readonly OtherCli[] = ['claude', 'codex']

const LABELS: Record<SessionCli, string> = { copilot: 'Copilot CLI', claude: 'Claude Code', codex: 'Codex CLI' }

export function sessionCliLabel(cli: SessionCli | undefined): string {
  return LABELS[cli ?? 'copilot']
}

export function isOtherCli(value: unknown): value is OtherCli {
  return value === 'claude' || value === 'codex'
}

/** What the new-session dialog shows for each CLI a tab can run: whether it was found, and how to get it when not. */
export interface SessionCliChoice {
  cli: SessionCli
  label: string
  version: string | null
  /** Why it cannot be started; null when it can. */
  error: string | null
}
