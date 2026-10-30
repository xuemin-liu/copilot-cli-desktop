import { MEETING_MARKER_PREFIX } from './meeting-messages.js'

/**
 * Reads one session's live event-log records to tell what each prompt was and what Copilot answered.
 *
 * Observed in local logs (CLI 1.0.80 to 1.0.103): a `user.message` and every `assistant.message` it caused share
 * `data.interactionId`; one prompt spans several `assistant.turn_end` records (one per model call), so the answer is complete
 * only when the session goes idle. Newer CLIs mark the answer with `phase: "final_answer"`; older ones do not, and there the
 * answer is the last message with text and no tool requests. Records of subagents (`agentId`, `parentToolCallId`) are not the
 * session's own conversation and are skipped, as the activity tracker does.
 */

interface TurnRecord {
  id?: unknown
  type?: unknown
  agentId?: unknown
  data?: {
    parentToolCallId?: unknown
    content?: unknown
    interactionId?: unknown
    turnId?: unknown
    messageId?: unknown
    phase?: unknown
    toolRequests?: unknown
    chunkIndex?: unknown
    chunkCount?: unknown
    totalNanoAiu?: unknown
    totalPremiumRequests?: unknown
  }
}

/** What a session has used so far, from its latest `session.usage_checkpoint` (running totals for the session). */
export interface MeetingUsage { nanoAiu: number; premiumRequests: number }

export interface PromptSeen {
  content: string
  /** The desktop typed it (a meeting message); otherwise the person did. */
  desktop: boolean
}

export interface CompletedTurn extends PromptSeen { reply: string }

interface Interaction extends PromptSeen {
  id: string | null
  final: string | null
  last: string | null
  chunks: Map<string, { count: number; parts: string[] }>
}

const MAX_CHUNKS = 64

/** Metadata only: never retain prompt, reply, tool arguments, or arbitrary record fields here. */
interface TurnEventDiagnostic { type: string; live: boolean; eventId: string | null; interactionId: string | null; turnId: string | null }

export interface MeetingTurnDiagnostic {
  live: boolean | null
  currentInteractionId: string | null
  currentDesktop: boolean | null
  expectingDesktop: boolean
  lastEvent: TurnEventDiagnostic | null
  lastClearedCurrent: { reason: string; event: TurnEventDiagnostic | null } | null
}

export class MeetingTurnReader {
  private current: Interaction | null = null
  private expectingDesktop = false
  private usageValue: MeetingUsage | null = null
  private usageChanged = false
  private lastEvent: TurnEventDiagnostic | null = null
  private lastClearedCurrent: MeetingTurnDiagnostic['lastClearedCurrent'] = null

  get diagnostic(): MeetingTurnDiagnostic {
    return {
      live: this.lastEvent?.live ?? null,
      currentInteractionId: this.current?.id?.slice(0, 128) ?? null,
      currentDesktop: this.current?.desktop ?? null,
      expectingDesktop: this.expectingDesktop,
      lastEvent: this.lastEvent,
      lastClearedCurrent: this.lastClearedCurrent,
    }
  }

  get startRejection(): string | null {
    if (this.answeringPerson) return null
    return this.current?.desktop
      ? 'Cannot start a meeting while answering a Desktop-generated turn. Start a meeting only when the person asks for one in their own message.'
      : 'Cannot start a meeting: no active user turn observed in the monitored session. Start a meeting only when the person asks for one in their own message.'
  }

  /** A new monitor/process, or a gap in the log, cannot inherit authorization or an expected Desktop prompt. */
  reset(reason: string): void {
    this.lastClearedCurrent = { reason, event: this.lastEvent }
    this.lastEvent = null
    this.current = null
    this.expectingDesktop = false
    this.usageValue = null
    this.usageChanged = false
  }

  /** The session's latest usage totals, from its history or since; null before any checkpoint. */
  get usage(): MeetingUsage | null { return this.usageValue }

  /** The totals, once, when a record read live changed them. */
  takeUsageChange(): MeetingUsage | null {
    if (!this.usageChanged) return null
    this.usageChanged = false
    return this.usageValue
  }

  /** The desktop is about to type a prompt; the next prompt recorded is that one. */
  expectDesktopPrompt(): void {
    this.expectingDesktop = true
  }

  /** Whether the prompt being answered now came from the person. */
  get answeringPerson(): boolean {
    return this.current !== null && !this.current.desktop
  }

  /**
   * Returns the prompt when the record is a new one, so joins can be read from what the person typed. History read when the
   * session (re)starts is not `live`: it only tells the usage so far, never a prompt to act on.
   */
  consume(line: string, live = true): PromptSeen | null {
    let record: TurnRecord
    try { record = JSON.parse(line) } catch { return null }
    if (!record || typeof record !== 'object' || record.agentId || record.data?.parentToolCallId) return null
    const data = record.data ?? {}
    // Only known event names, and bounded identifiers, go into rejection diagnostics.
    const type = typeof record.type === 'string' && /^(?:user\.message|assistant\.(?:message|turn_start|turn_end)|session\.(?:start|resume|usage_checkpoint)|tool\.execution_(?:start|complete)|abort)$/.test(record.type) ? record.type : 'other'
    const identifier = (value: unknown): string | null => typeof value === 'string' ? value.slice(0, 128) : null
    this.lastEvent = { type, live, eventId: identifier(record.id), interactionId: identifier(data.interactionId), turnId: identifier(data.turnId) }
    if (record.type === 'session.usage_checkpoint') {
      const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
      this.usageValue = { nanoAiu: count(data.totalNanoAiu), premiumRequests: count(data.totalPremiumRequests) }
      this.usageChanged = live
      return null
    }
    if (!live) return null
    if (record.type === 'user.message') {
      if (typeof data.content !== 'string') return null
      const desktop = this.expectingDesktop || data.content.startsWith(MEETING_MARKER_PREFIX)
      this.expectingDesktop = false
      this.current = { id: typeof data.interactionId === 'string' ? data.interactionId : null, content: data.content, desktop, final: null, last: null, chunks: new Map() }
      return { content: data.content, desktop }
    }
    if (record.type !== 'assistant.message' || !this.current) return null
    const interaction = this.current
    if (interaction.id !== null && typeof data.interactionId === 'string' && data.interactionId !== interaction.id) return null
    const content = this.joinChunks(interaction, data)
    if (content === null) return null
    if (data.phase === 'final_answer') interaction.final = content
    else if (content.trim() && (!Array.isArray(data.toolRequests) || data.toolRequests.length === 0)) interaction.last = content
    return null
  }

  /** The session went idle: the prompt being answered is done. Null when there was none (or it was already reported). */
  finish(reason = 'idle'): CompletedTurn | null {
    const interaction = this.current
    this.current = null
    if (!interaction) return null
    this.lastClearedCurrent = { reason, event: this.lastEvent }
    return { content: interaction.content, desktop: interaction.desktop, reply: interaction.final ?? interaction.last ?? '' }
  }

  /** A message split into chunks (none observed so far, but the fields exist) counts once all its chunks are in. */
  private joinChunks(interaction: Interaction, data: NonNullable<TurnRecord['data']>): string | null {
    if (typeof data.content !== 'string') return null
    const count = typeof data.chunkCount === 'number' && Number.isInteger(data.chunkCount) ? data.chunkCount : 1
    if (count <= 1 || typeof data.messageId !== 'string') return data.content
    const index = typeof data.chunkIndex === 'number' && Number.isInteger(data.chunkIndex) ? data.chunkIndex : -1
    if (count > MAX_CHUNKS || index < 0 || index >= count) return null
    const entry = interaction.chunks.get(data.messageId) ?? { count, parts: [] }
    entry.parts[index] = data.content
    interaction.chunks.set(data.messageId, entry)
    if (entry.parts.filter((part) => part !== undefined).length < count) return null
    interaction.chunks.delete(data.messageId)
    return entry.parts.join('')
  }
}
