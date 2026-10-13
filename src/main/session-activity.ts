import { MAX_RUNNING_TOOLS, clampTimestamp, toolDetailFor, toolTitleFor, type ActivityDetail, type ToolActivity } from './activity-label.js'

export type SessionActivity = 'working' | 'idle'

interface RunningTool extends ToolActivity {
  since: number
}

interface ActivityEvent {
  type?: unknown
  agentId?: unknown
  timestamp?: unknown
  data?: {
    parentToolCallId?: unknown
    turnId?: unknown
    content?: unknown
    toolRequests?: unknown
    toolCallId?: unknown
    toolName?: unknown
    arguments?: unknown
    context?: { cwd?: unknown }
  }
}

const MAX_CWD_CHARS = 4_096

/** A turn may end after tool calls and immediately start another model call.
 * Only a root turn with a final, tool-free response establishes idle.
 *
 * Besides the coarse activity, the tracker keeps a bounded set of the tools running in the
 * current root turn (tools overlap: most tool starts in real logs happen while another tool of
 * the same turn is still running) and exposes it as `detail` for the sidebar's activity line. */
export class SessionActivityTracker {
  activity: SessionActivity | null = null
  private turnId: string | null = null
  private finalResponse = false
  private readonly runningTools = new Map<string, RunningTool>()
  private thinkingSince: number | null = null
  /** The folder the session reports it runs in (`session.start` / `session.resume`); the latest record wins. */
  sessionCwd: string | null = null

  constructor(private readonly clock: () => number = Date.now) {}

  reset(): void {
    this.activity = null
    this.turnId = null
    this.finalResponse = false
    this.clearDetail()
    this.sessionCwd = null
  }

  /** What the session is doing inside the current turn; null when idle or unknown. */
  get detail(): ActivityDetail | null {
    if (this.runningTools.size > 0) {
      const tools = [...this.runningTools.values()]
      return {
        kind: 'tools',
        tools: tools.map(({ title, detail }) => ({ title, detail })),
        since: Math.min(...tools.map((tool) => tool.since)),
      }
    }
    return this.thinkingSince === null ? null : { kind: 'thinking', since: this.thinkingSince }
  }

  private clearDetail(): void {
    this.runningTools.clear()
    this.thinkingSince = null
  }

  /** undefined means unchanged; null explicitly clears unreliable activity. */
  consume(line: string): SessionActivity | null | undefined {
    let event: ActivityEvent | null
    try { event = JSON.parse(line) } catch { return undefined }
    if (!event || typeof event !== 'object' || event.agentId || event.data?.parentToolCallId) return undefined
    const before = this.activity
    switch (event.type) {
      case 'assistant.turn_start':
        if (typeof event.data?.turnId !== 'string') return undefined
        this.turnId = event.data.turnId
        this.finalResponse = false
        this.activity = 'working'
        this.clearDetail()
        this.thinkingSince = clampTimestamp(event.timestamp, this.clock())
        break
      case 'assistant.message':
        if (!this.turnId) return undefined
        this.finalResponse = typeof event.data?.content === 'string'
          && (Array.isArray(event.data.toolRequests) ? event.data.toolRequests.length === 0 : event.data.toolRequests === undefined)
        break
      case 'tool.execution_start':
        if (!this.turnId) return undefined
        this.finalResponse = false
        this.activity = 'working'
        this.startTool(event)
        break
      case 'tool.execution_complete':
        if (!this.turnId) return undefined
        this.completeTool(event)
        break
      case 'assistant.turn_end':
        if (event.data?.turnId !== this.turnId || this.turnId === null) return undefined
        this.activity = this.finalResponse ? 'idle' : null
        this.turnId = null
        this.finalResponse = false
        this.clearDetail()
        break
      case 'abort':
        this.activity = 'idle'
        this.turnId = null
        this.finalResponse = false
        this.clearDetail()
        break
      case 'session.start':
      case 'session.resume': {
        const cwd = event.data?.context?.cwd
        if (typeof cwd === 'string' && cwd.length > 0 && cwd.length <= MAX_CWD_CHARS) this.sessionCwd = cwd
        break
      }
    }
    return this.activity !== before ? this.activity : undefined
  }

  private startTool(event: ActivityEvent): void {
    const id = event.data?.toolCallId
    if (typeof id !== 'string' || id.length === 0 || this.runningTools.has(id)) return
    // Bounded: a log that never completes its tools cannot grow the set or the IPC broadcast.
    if (this.runningTools.size >= MAX_RUNNING_TOOLS) return
    const now = this.clock()
    this.runningTools.set(id, {
      title: toolTitleFor(event.data?.toolName),
      detail: toolDetailFor(event.data?.toolName, event.data?.arguments),
      since: clampTimestamp(event.timestamp, now),
    })
    this.thinkingSince = null
  }

  private completeTool(event: ActivityEvent): void {
    const id = event.data?.toolCallId
    if (typeof id !== 'string' || !this.runningTools.delete(id)) return
    if (this.runningTools.size === 0) this.thinkingSince = clampTimestamp(event.timestamp, this.clock())
  }

  /** Historical unfinished work is not evidence that this process is working. */
  finishReplay(): SessionActivity | null {
    if (this.activity !== 'idle') this.activity = null
    this.turnId = null
    this.finalResponse = false
    this.clearDetail()
    return this.activity
  }
}
