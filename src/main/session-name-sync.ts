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

/**
 * Whether the prompt box may hold something the person typed. The desktop types `/rename` into the session only while
 * it is empty, since a draft would be sent to the model with the command appended. Only Enter (submits) and Ctrl+C
 * (clears) make it empty again; anything else, including arrow keys and pastes, counts as a draft.
 */
export class PromptDraft {
  private dirty: boolean
  private lastInputAt = 0
  private pickerShowing: boolean

  /** `awaitingFirstEnter`: the session may open on a screen of its own (the resume picker), where typed text would pick
   * something; it counts as a draft until the first Enter. */
  constructor({ awaitingFirstEnter = false }: { awaitingFirstEnter?: boolean } = {}) {
    this.dirty = awaitingFirstEnter
    this.pickerShowing = awaitingFirstEnter
  }

  /** Still before the first Enter of a session that opened on the resume picker. */
  get beforeFirstEnter(): boolean { return this.pickerShowing }

  note(data: string, now = Date.now()): void {
    const text = data.replace(NON_TEXT_INPUT, '')
    if (!text) return
    this.lastInputAt = now
    const last = text.at(-1)
    // Alt+Enter (`ESC CR`) adds a line to the draft rather than sending it.
    this.dirty = !((last === '\r' && !text.endsWith('\x1b\r')) || last === '\x03')
    if (last === '\r') this.pickerShowing = false
  }

  get empty(): boolean { return !this.dirty }

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
