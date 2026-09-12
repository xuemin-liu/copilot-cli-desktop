export type SessionActivity = 'working' | 'idle'

/** A turn may end after tool calls and immediately start another model call.
 * Only a root turn with a final, tool-free response establishes idle. */
export class SessionActivityTracker {
  activity: SessionActivity | null = null
  private turnId: string | null = null
  private finalResponse = false

  reset(): void {
    this.activity = null
    this.turnId = null
    this.finalResponse = false
  }

  consume(line: string): SessionActivity | null {
    let event: { type?: unknown; agentId?: unknown; data?: { parentToolCallId?: unknown; turnId?: unknown; content?: unknown; toolRequests?: unknown } } | null
    try { event = JSON.parse(line) } catch { return null }
    if (!event || typeof event !== 'object' || event.agentId || event.data?.parentToolCallId) return null
    const before = this.activity
    switch (event.type) {
      case 'assistant.turn_start':
        if (typeof event.data?.turnId !== 'string') return null
        this.turnId = event.data.turnId
        this.finalResponse = false
        this.activity = 'working'
        break
      case 'assistant.message':
        if (!this.turnId) return null
        this.finalResponse = typeof event.data?.content === 'string'
          && (Array.isArray(event.data.toolRequests) ? event.data.toolRequests.length === 0 : event.data.toolRequests === undefined)
        break
      case 'tool.execution_start':
        if (!this.turnId) return null
        this.finalResponse = false
        this.activity = 'working'
        break
      case 'assistant.turn_end':
        if (event.data?.turnId !== this.turnId || this.turnId === null) return null
        if (this.finalResponse) this.activity = 'idle'
        this.turnId = null
        this.finalResponse = false
        break
      case 'abort':
        this.activity = 'idle'
        this.turnId = null
        this.finalResponse = false
        break
    }
    return this.activity !== before ? this.activity : null
  }

  /** Historical unfinished work is not evidence that this process is working. */
  finishReplay(): SessionActivity | null {
    if (this.activity !== 'idle') this.activity = null
    this.turnId = null
    this.finalResponse = false
    return this.activity
  }
}
