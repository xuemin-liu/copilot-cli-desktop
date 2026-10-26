import type { PermissionPreset } from './permission-presets.js'
import type { SessionActivity } from './session-activity.js'
import type { SessionLifecycleStatus } from './types.js'

/**
 * A task the desktop composed (the Git panel's "Resolve with Copilot") is typed into the session and sent only when that
 * cannot disturb anything, the same moment `/rename` waits for. Otherwise the renderer pastes it into the prompt box and the
 * person presses Enter.
 * - `sent`: typed and submitted.
 * - `busy`: not now (mid-turn, a draft in the prompt box, a key just pressed, no bracketed paste); paste it instead.
 * - `refused`: the session cannot do the task at all; `message` says why.
 */
export type SessionTaskSend = { result: 'sent' } | { result: 'busy'; message: string } | { result: 'refused'; message: string }

export interface SessionTaskState {
  status: SessionLifecycleStatus
  activity: SessionActivity | null
  /** Before any turn there is no activity yet; the prompt's footer is on screen. */
  promptVisible: boolean
  preset: PermissionPreset | null
  sideChat: boolean
  remote: boolean
  /** The prompt box may hold something the person typed. */
  draft: boolean
  /** A key was pressed in the last moment. */
  recentInput: boolean
  /** Still on the resume picker, where typed text would pick something. */
  picker: boolean
  /** The desktop is already typing into this session (a `/rename`). */
  typing: boolean
  /** The terminal has bracketed paste on, so a multi-line task arrives as one paste instead of a line at a time. */
  bracketedPaste: boolean
}

const MAX_TASK_CHARS = 12_000
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/** Why the session can never take a task that edits files and runs Git, or null when it can. The renderer shows it on the
 * button; main checks it again before typing anything. A task that only asks for an answer (a meeting's review round) passes
 * `needsWrite: false`, so read-only sessions and side chats can take it. */
export function sessionTaskBlocker(session: Pick<SessionTaskState, 'status' | 'preset' | 'sideChat' | 'remote'>, needsWrite = true): string | null {
  if (session.remote) return 'This session runs on another machine, so it cannot work in this folder.'
  if (needsWrite && session.sideChat) return 'A side chat cannot edit files or run Git. Use its main session.'
  if (needsWrite && session.preset === 'read-only') return 'This session is read-only, so it cannot edit files or run Git. Start a session that can.'
  if (session.status !== 'running' && session.status !== 'approval-needed') return 'This session is not running. Start or resume it first.'
  return null
}

export function sessionTaskDecision(state: SessionTaskState, needsWrite = true): SessionTaskSend {
  const blocker = sessionTaskBlocker(state, needsWrite)
  if (blocker) return { result: 'refused', message: blocker }
  const idle = state.activity === 'idle' || (state.activity === null && state.promptVisible)
  if (state.status === 'approval-needed' || !idle) return { result: 'busy', message: 'Copilot is busy.' }
  if (state.picker || state.typing || state.draft || state.recentInput) return { result: 'busy', message: 'The prompt box is in use.' }
  if (!state.bracketedPaste) return { result: 'busy', message: 'The task has several lines, and this terminal would send each one on its own.' }
  return { result: 'sent' }
}

/** The task as one bracketed paste: bounded, with control characters (and so any paste-end marker) removed. Enter follows separately. */
export function taskPasteSequence(text: string): string {
  const bounded = text.slice(0, MAX_TASK_CHARS).replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '')
  return `\u001b[200~${bounded}\u001b[201~`
}

/** Tracks DECSET 2004 (bracketed paste) across output chunks, which may split the sequence anywhere. */
export class BracketedPasteTracker {
  private tail = ''
  on = false

  note(data: string): void {
    const text = this.tail + data
    const enabled = text.lastIndexOf('\u001b[?2004h')
    const disabled = text.lastIndexOf('\u001b[?2004l')
    if (enabled !== disabled) this.on = enabled > disabled
    this.tail = text.slice(-7)
  }
}
