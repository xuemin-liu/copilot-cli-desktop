import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isValidSessionId } from './session-id.js'

/**
 * Keeps a tab's title and its Copilot session's name in step. Copilot keeps the name only in
 * `<session-state>/<id>/workspace.yaml` (`name:`, and `user_named:` when someone chose it): a session started without
 * `--name` is named by Copilot from its first prompt, and `/rename <name>` inside the session changes it. There is no
 * event for either, so the file is read again when it changes.
 */
export interface CopilotSessionName { name: string; userNamed: boolean }

export const MAX_COPILOT_NAME_CHARS = 120

/** One top-level YAML scalar: plain, 'single-quoted' or "double-quoted". Block scalars (`|`, `>`) are not names Copilot writes. */
function yamlScalar(raw: string): string | null {
  const value = raw.trim()
  if (!value || value.startsWith('|') || value.startsWith('>')) return null
  if (value.startsWith("'")) {
    const end = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(value)
    return end ? end[1]!.replace(/''/g, "'") : null
  }
  if (value.startsWith('"')) {
    const end = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(value)
    if (!end) return null
    try { return JSON.parse(end[1]!) as string } catch { return end[1]!.slice(1, -1) }
  }
  return value.replace(/\s+#.*$/, '').trim() || null
}

/** One top-level scalar field of Copilot's workspace.yaml, or null when it is missing or not a plain scalar. */
export function workspaceField(text: string, key: string): string | null {
  const raw = text.split(/\r?\n/).find(line => line.startsWith(`${key}:`))?.slice(key.length + 1)
  return raw === undefined ? null : yamlScalar(raw)
}

/** The session name in Copilot's workspace.yaml, or null when it has none yet. */
export function parseWorkspaceName(text: string): CopilotSessionName | null {
  const name = workspaceField(text, 'name')
  if (!name) return null
  return { name, userNamed: workspaceField(text, 'user_named') === 'true' }
}

/** Reads a session's name; null when the file or the name is missing. `known` skips the read when the file is unchanged. */
export async function readCopilotSessionName(root: string, sessionId: string, known?: { mtimeMs: number; value: CopilotSessionName | null })
  : Promise<{ mtimeMs: number; value: CopilotSessionName | null }> {
  if (!isValidSessionId(sessionId)) return { mtimeMs: 0, value: null }
  const file = join(root, sessionId, 'workspace.yaml')
  let mtimeMs: number
  try { mtimeMs = (await stat(file)).mtimeMs } catch { return { mtimeMs: 0, value: null } }
  if (known && known.mtimeMs === mtimeMs) return known
  try { return { mtimeMs, value: parseWorkspaceName((await readFile(file, 'utf8')).slice(0, 64 * 1024)) } }
  catch { return { mtimeMs: 0, value: null } }
}

/** The command that renames the session in Copilot: one line, no control characters, bounded. */
export function renameCommand(title: string): string | null {
  const name = title.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_COPILOT_NAME_CHARS)
  return name ? `/rename ${name}` : null
}

// Mouse reports (Copilot runs with --mouse=on), focus reports, and the terminal's answers to the CLI's own queries are input
// that never touches the prompt box. The answers arrive when a terminal attaches: colour replies (OSC 4/10/11, ended by BEL
// or ST), cursor position (CPR), device attributes (DA) and status (DSR, DECRPM) reports.
const NON_TEXT_INPUT = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[[IO]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[\??\d+;\d+R|\x1b\[[?>]?[\d;]*c|\x1b\[\??[\d;]*\$y|\x1b\[\??\d+n/g

// Keys that put nothing in the prompt box: Esc, and moving the caret or the view (Left, Right, Home, End, PageUp, PageDown).
const NO_TEXT_KEYS = /^(?:\x1b(?:\[(?:1;\d+)?[CDHF]|O[CDHF]|\[[1456789](?:;\d+)?~)|\x1b)+$/
// Up and Down: these recall an earlier prompt into the box.
const RECALL_KEYS = /^(?:\x1b(?:\[[AB]|O[AB]))+$/

/**
 * What the prompt box holds, as far as the keys pressed can tell. The desktop types into the session only while it is empty,
 * since a draft would be sent to the model with the typed text appended. A key that adds nothing leaves it as it was, and text
 * typed and then deleted leaves it empty. A recalled prompt is apart: it is only history, so Ctrl+C loses nothing the person
 * wrote. Whatever cannot be followed for certain (an edit after moving the caret, a key not known here) counts as a draft
 * until Enter or Ctrl+C.
 */
export class PromptDraft {
  private content: 'empty' | 'recalled' | 'typed'
  /** Characters in the box when it holds `typed` text; null once that can no longer be followed for certain. */
  private typedChars: number | null = 0
  private contextText: string | null = ''
  private lastInputAt = 0
  private pickerShowing: boolean
  private commandSubmitted = false

  /** `awaitingFirstEnter`: the session may open on a screen of its own (the resume picker), where typed text would pick
   * something; it counts as a draft until the first Enter. */
  constructor({ awaitingFirstEnter = false }: { awaitingFirstEnter?: boolean } = {}) {
    this.content = awaitingFirstEnter ? 'typed' : 'empty'
    this.typedChars = awaitingFirstEnter ? null : 0
    this.pickerShowing = awaitingFirstEnter
  }

  /** Still before the first Enter of a session that opened on the resume picker. */
  get beforeFirstEnter(): boolean { return this.pickerShowing }

  /** `dialogShown`: a dialog's hints are on screen as this key is pressed, so an arrow key moves its selection. */
  note(data: string, now = Date.now(), dialogShown = false): void {
    const text = data.replace(NON_TEXT_INPUT, '')
    if (!text) return
    const before = this.contextText
    this.noteContextText(text)
    this.lastInputAt = now
    const last = text.at(-1)
    // Alt+Enter (`ESC CR`) adds a line to the draft rather than sending it.
    if ((last === '\r' && !text.endsWith('\x1b\r')) || last === '\x03') {
      this.content = 'empty'
      this.typedChars = 0
      // What it submitted is not known when the caret moved: that may have been a command too.
      this.commandSubmitted = last === '\r' && !text.startsWith('\x1b[200~[meeting ') && (before === null || (before + text).trimStart().startsWith('/'))
    } else this.noteContent(text, dialogShown)
    if (last === '\r') this.pickerShowing = false
  }

  private noteContent(text: string, dialogShown: boolean): void {
    if (NO_TEXT_KEYS.test(text)) {
      // With text in the box the caret may have moved, so a later Backspace may not delete what it seems to.
      if (this.content === 'typed') this.typedChars = null
      // Esc closes a dialog, and is what the person is told to press.
      if (/^\x1b+$/.test(text)) this.commandSubmitted = false
      return
    }
    if (RECALL_KEYS.test(text)) {
      // In a dialog these move its selection, and clearing the box would close it.
      if (this.commandSubmitted && dialogShown) return
      if (this.commandSubmitted) { this.content = 'typed'; this.typedChars = null; return } // Which of the two is not known.
      if (this.content === 'empty') this.content = 'recalled'
      else if (this.content === 'typed') this.typedChars = null
      return
    }
    // An edit of a recalled prompt is the person's own text now, of a length not known here. Only keys typed one by one and deleted
    // one by one can prove the box empty: a paste may hold several lines, and Ctrl+U clears only the line the caret is on.
    let chars = this.content === 'recalled' ? null : this.typedChars
    for (const char of text) {
      if (chars === null) break
      if (char === '\x7f' || char === '\b') chars = Math.max(0, chars - 1)
      else if (char >= ' ') chars++
      else chars = null
    }
    this.typedChars = chars
    this.content = chars === 0 ? 'empty' : 'typed'
  }

  get empty(): boolean { return this.content === 'empty' }

  /** It holds only a prompt recalled from history, with nothing the person wrote: Ctrl+C clears it and loses nothing. */
  get recalled(): boolean { return this.content === 'recalled' }

  /** It may hold what the person wrote: never typed over, and never cleared for them. */
  get typed(): boolean { return this.content === 'typed' }

  /** A command went in last, which may have opened a dialog that takes the keys meant for the prompt. */
  get afterCommand(): boolean { return this.commandSubmitted }

  /** The desktop typed that command itself, and it is known to open no dialog. */
  commandOpensNoDialog(): void { this.commandSubmitted = false }

  /** Only attach to a known ordinary prompt with the caret at its end. Commands, history/picker navigation and
   * unrecognized editing sequences must keep their native Enter behavior. */
  get canAttachContext(): boolean {
    const text = this.contextText?.trimStart()
    return !this.pickerShowing && !!text && !text.startsWith('/') && !text.startsWith('!')
  }

  /** Approval input can clear the CLI's badge before its Enter arrives. Keep that entire response free of context. */
  suppressContext(): void { this.contextText = null }

  private noteContextText(text: string): void {
    if (text === '\r' || text === '\x03') { this.contextText = ''; return }
    if (this.contextText === null) return
    if (text.startsWith('\x1b[200~') && text.endsWith('\x1b[201~')) {
      const pasted = text.slice(6, -6).replace(/\r\n?/g, '\n')
      this.contextText = /[\x00-\x08\x0b-\x1f\x7f]/.test(pasted) ? null : this.contextText + pasted
    } else if (text === '\x1b\r') this.contextText += '\n'
    else {
      for (const char of text) {
        if (char === '\x7f' || char === '\b') this.contextText = Array.from(this.contextText).slice(0, -1).join('')
        else if (char === '\x15') this.contextText = this.contextText.slice(0, this.contextText.lastIndexOf('\n') + 1)
        else if (char === '\x17') this.contextText = this.contextText.replace(/\S+\s*$/, '')
        else if (char >= ' ' || char === '\n') this.contextText += char
        else { this.contextText = null; break }
      }
    }
    if (this.contextText !== null && this.contextText.length > 12_000) this.contextText = null
  }

  /** No input for a while: a prompt just sent has had time to show up as Copilot's turn. */
  quiet(now = Date.now(), ms = 2_000): boolean { return now - this.lastInputAt >= ms }
}

/**
 * What a tab's title and its Copilot session's name call for. `copilot` undefined means the name has not been read yet.
 * Only a rename made in the desktop (`renamePending`) is typed into the session; a tab saved by an older release whose
 * title differs from its Copilot name is left alone rather than have `/rename` appear in it unasked.
 */
export function nameSyncAction(
  tab: { title: string; autoTitle?: boolean; renamePending?: boolean; remote: boolean; lastSessionId: string | null },
  copilot: CopilotSessionName | null | undefined,
): { kind: 'none' } | { kind: 'adopt'; title: string } | { kind: 'rename'; title: string } | { kind: 'confirmed' } {
  if (tab.remote || !tab.lastSessionId || copilot === undefined) return { kind: 'none' }
  if (tab.autoTitle) return copilot && copilot.name !== tab.title ? { kind: 'adopt', title: copilot.name.slice(0, MAX_COPILOT_NAME_CHARS) } : { kind: 'none' }
  if (!tab.renamePending) return { kind: 'none' }
  return copilot?.name === tab.title ? { kind: 'confirmed' } : { kind: 'rename', title: tab.title }
}
