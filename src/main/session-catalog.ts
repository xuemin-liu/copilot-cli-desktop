import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readSessionStart } from './session-store-discovery.js'
import { workspaceField } from './session-name-sync.js'
import type { SessionHistoryEntry } from './types.js'

/**
 * The sessions Copilot has stored (`<session-state>/<id>/`), for the History list: enough to tell them apart when many
 * share a folder and a name. Everything here is data the CLI wrote, read in bounded slices: `workspace.yaml` for the name,
 * folder and branch, and the head and tail of `events.jsonl` for the first and latest prompt.
 */
export type StoredSession = Omit<SessionHistoryEntry, 'openTabId' | 'projectName'>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WORKSPACE_BYTES = 64 * 1024
const PROMPT_SLICE_BYTES = 256 * 1024
export const MAX_PROMPT_CHARS = 280
const MAX_FIELD_CHARS = 1_024

/** Read results by session, kept while the session's files are unchanged. */
export type SessionCatalogCache = Map<string, { stamp: string; value: StoredSession }>

/** One line of shown text: control characters dropped, whitespace collapsed, bounded. */
export function promptText(value: string): string | null {
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS - 1)}…` : text
}

function boundedField(value: string | null): string | null {
  return value && value.length <= MAX_FIELD_CHARS ? value : null
}

/** The user prompts in complete event lines of `text`, in order. */
export function promptsIn(text: string): string[] {
  const prompts: string[] = []
  for (const line of text.split('\n')) {
    if (!line.includes('"user.message"')) continue
    try {
      const event = JSON.parse(line) as { type?: unknown; data?: { content?: unknown } }
      if (event.type !== 'user.message' || typeof event.data?.content !== 'string') continue
      const prompt = promptText(event.data.content)
      if (prompt) prompts.push(prompt)
    } catch { /* a line cut by the slice or not JSON */ }
  }
  return prompts
}

/** The first prompt from the head of the event log and the latest from its tail. */
async function readPrompts(path: string, size: number): Promise<{ first: string | null; last: string | null }> {
  const handle = await open(path, 'r')
  try {
    const read = async (position: number, length: number): Promise<string> => {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      return buffer.subarray(0, bytesRead).toString('utf8')
    }
    // A slice that stops mid-file ends with a partial line; promptsIn skips it.
    const head = promptsIn(await read(0, Math.min(size, PROMPT_SLICE_BYTES)))
    const first = head[0] ?? null
    if (size <= PROMPT_SLICE_BYTES) return { first, last: head.at(-1) ?? null }
    const tail = await read(size - PROMPT_SLICE_BYTES, PROMPT_SLICE_BYTES)
    return { first, last: promptsIn(tail.slice(tail.indexOf('\n') + 1)).at(-1) ?? first }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function modified(path: string): Promise<{ mtimeMs: number; size: number } | null> {
  try { const info = await stat(path); return info.isFile() ? { mtimeMs: info.mtimeMs, size: info.size } : null } catch { return null }
}

async function readSession(root: string, sessionId: string, events: { mtimeMs: number; size: number } | null,
  workspace: { mtimeMs: number; size: number } | null): Promise<StoredSession> {
  const directory = join(root, sessionId)
  const yaml = workspace && workspace.size <= WORKSPACE_BYTES ? await readFile(join(directory, 'workspace.yaml'), 'utf8').catch(() => '') : ''
  const field = (key: string): string | null => boundedField(yaml ? workspaceField(yaml, key) : null)
  // A session without workspace.yaml still says where it started.
  const start = field('cwd') === null && events ? await readSessionStart(join(directory, 'events.jsonl')) : null
  const prompts = events && events.size > 0 ? await readPrompts(join(directory, 'events.jsonl'), events.size).catch(() => ({ first: null, last: null })) : { first: null, last: null }
  const name = field('name')
  const created = Date.parse(field('created_at') ?? '')
  return {
    sessionId,
    name: name ? promptText(name) : null,
    userNamed: field('user_named') === 'true',
    cwd: field('cwd') ?? boundedField(start?.cwd ?? null),
    gitRoot: field('git_root'),
    repository: field('repository'),
    branch: field('branch'),
    createdAt: Number.isFinite(created) ? created : start?.startTime ?? null,
    updatedAt: Math.max(events?.mtimeMs ?? 0, workspace?.mtimeMs ?? 0),
    firstPrompt: prompts.first,
    lastPrompt: prompts.last,
  }
}

/** The most recently used stored sessions, newest first. Sessions that never received a prompt are left out: there is
 * nothing in them to go back to. */
export async function listStoredSessions(root: string, options: { limit?: number; cache?: SessionCatalogCache } = {}): Promise<StoredSession[]> {
  const limit = options.limit ?? 200
  let names: string[]
  try { names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && UUID.test(entry.name)).map((entry) => entry.name) }
  catch { return [] }
  const stamped = await Promise.all(names.map(async (sessionId) => {
    const [events, workspace] = await Promise.all([modified(join(root, sessionId, 'events.jsonl')), modified(join(root, sessionId, 'workspace.yaml'))])
    return { sessionId, events, workspace, updatedAt: Math.max(events?.mtimeMs ?? 0, workspace?.mtimeMs ?? 0) }
  }))
  const recent = stamped.filter((entry) => entry.events).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit)
  const sessions = await Promise.all(recent.map(async ({ sessionId, events, workspace }) => {
    const stamp = `${events?.mtimeMs}:${events?.size}:${workspace?.mtimeMs}:${workspace?.size}`
    const known = options.cache?.get(sessionId)
    if (known?.stamp === stamp) return known.value
    const value = await readSession(root, sessionId, events, workspace)
    options.cache?.set(sessionId, { stamp, value })
    return value
  }))
  return sessions.filter((session) => session.firstPrompt !== null || session.lastPrompt !== null)
}
