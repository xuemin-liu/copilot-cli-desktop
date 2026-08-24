/**
 * `copilot --resume` opens an interactive session picker; `copilot --resume
 * SESSION-ID` (or `--resume=<name>`) jumps directly to a session; `copilot
 * --continue` resumes the most recent session (preferring the current working
 * directory). This module turns a small, testable "resume mode" into the
 * corresponding CLI flags.
 */
export type ResumeMode = 'new' | 'auto-resume' | 'continue' | 'picker'

export const RESUME_MODES: readonly ResumeMode[] = ['new', 'auto-resume', 'continue', 'picker']

export function isResumeMode(value: unknown): value is ResumeMode {
  return typeof value === 'string' && (RESUME_MODES as readonly string[]).includes(value)
}

export interface ResumeArgsInput {
  mode: ResumeMode
  lastSessionId: string | null
}

/**
 * `auto-resume` falls back to starting a new session when no session id is
 * known yet (e.g. the very first time a tab is opened for a workspace).
 */
export function buildResumeArgs({ mode, lastSessionId }: ResumeArgsInput): string[] {
  switch (mode) {
    case 'new':
      return []
    case 'continue':
      return ['--continue']
    case 'picker':
      return ['--resume']
    case 'auto-resume':
      return lastSessionId ? ['--resume', lastSessionId] : []
    default: {
      const exhaustive: never = mode
      throw new Error(`Unknown resume mode: ${String(exhaustive)}`)
    }
  }
}
