/** Pure formatting for the sidebar's live activity line. Shared by the main process and the renderer.
 *
 * Everything that reaches this module came from a session event log written by the model, by tools,
 * and by third-party MCP servers. Titles are therefore allowlisted by tool name and never taken from
 * the log, and the only log-derived text that is shown is a bounded, cleaned file name. */

export interface ToolActivity {
  /** Allowlisted title such as "Running command" or "Viewing". */
  title: string
  /** Bounded, cleaned file name for file tools; null for everything else. */
  detail: string | null
}

export type ActivityDetail =
  | { kind: 'tools'; tools: ToolActivity[]; since: number }
  | { kind: 'thinking'; since: number }

/** At most this many running tools are remembered per session. */
export const MAX_RUNNING_TOOLS = 16
/** File names shown in the sidebar are cut to this many characters. */
export const MAX_DETAIL_CHARS = 40
/** A record timestamp older than this is treated as unreliable and clamped. */
export const MAX_TIMESTAMP_AGE_MS = 24 * 60 * 60 * 1_000

const TOOL_TITLES: Readonly<Record<string, string>> = {
  powershell: 'Running command',
  bash: 'Running command',
  shell: 'Running command',
  view: 'Viewing',
  edit: 'Editing',
  create: 'Editing',
  apply_patch: 'Editing',
  glob: 'Searching',
  grep: 'Searching',
  rg: 'Searching',
  fetch: 'Fetching',
  web_fetch: 'Fetching',
  ask_user: 'Asking you',
}

const FILE_TOOLS: ReadonlySet<string> = new Set(['view', 'edit', 'create'])

/** The CLI's own `toolTitle` is deliberately not consulted: for MCP tools it is third-party text. */
export function toolTitleFor(toolName: unknown): string {
  return (typeof toolName === 'string' && Object.hasOwn(TOOL_TITLES, toolName)) ? TOOL_TITLES[toolName]! : 'Running tool'
}

/** Last path segment with control, format and bidi characters removed, bounded to MAX_DETAIL_CHARS. */
export function cleanFileDetail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const segments = value.split(/[\\/]+/).filter((segment) => segment.length > 0)
  const name = (segments.at(-1) ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim()
  if (name.length === 0) return null
  return name.length > MAX_DETAIL_CHARS ? `${name.slice(0, MAX_DETAIL_CHARS - 1)}…` : name
}

/** Detail for a tool start record: a file name for file tools, nothing (ever) for shell and other tools. */
export function toolDetailFor(toolName: unknown, args: unknown): string | null {
  if (typeof toolName !== 'string' || !FILE_TOOLS.has(toolName)) return null
  if (!args || typeof args !== 'object') return null
  return cleanFileDetail((args as { path?: unknown }).path)
}

/** A record's own timestamp is data: parse it, and clamp it into the last day so a forged or
 * clock-skewed value cannot show a negative or absurd elapsed time. */
export function clampTimestamp(value: unknown, now: number): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(parsed)) return now
  return Math.min(now, Math.max(now - MAX_TIMESTAMP_AGE_MS, parsed))
}

export function formatElapsed(since: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/** "Running command, Viewing foo.ts" with "+N" when more than two tools run at once. */
export function formatActivityLabel(detail: ActivityDetail): string {
  if (detail.kind === 'thinking') return 'Thinking'
  const shown = detail.tools.slice(0, 2).map((tool) => tool.detail ? `${tool.title} ${tool.detail}` : tool.title)
  const extra = detail.tools.length - shown.length
  return shown.length === 0 ? 'Thinking' : `${shown.join(', ')}${extra > 0 ? ` +${extra}` : ''}`
}

export function sameActivityDetail(left: ActivityDetail | null, right: ActivityDetail | null): boolean {
  if (left === right) return true
  if (!left || !right || left.kind !== right.kind || left.since !== right.since) return false
  if (left.kind !== 'tools' || right.kind !== 'tools') return true
  return left.tools.length === right.tools.length
    && left.tools.every((tool, index) => tool.title === right.tools[index]!.title && tool.detail === right.tools[index]!.detail)
}
