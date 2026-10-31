import type { SessionTaskSend } from './session-task.js'
import type { MeetingDelivery } from './meeting.js'

/**
 * One queue per session of what meetings want typed into it. A message is typed only through the same gate as every other
 * desktop-composed prompt (idle, empty and quiet prompt box); `busy` keeps it queued for the next try. After a message is
 * typed, nothing else goes to that session until its turn ends, so one session never gets two meeting prompts at once.
 */

export interface MeetingOutboxDeps {
  sendTask(tabId: string, text: string): SessionTaskSend
  /** Types a one-line slash command; false when the session cannot take it now. */
  sendCommand(tabId: string, command: string): boolean
  /** A prompt was typed; its turn's answer belongs to this delivery. */
  sent(tabId: string, delivery: MeetingDelivery): void
  refused(tabId: string, delivery: MeetingDelivery, message: string): void
  now(): number
}

/** A slash command makes no turn; give the CLI a moment before typing the next thing. */
const COMMAND_SETTLE_MS = 1_500

interface Queue {
  items: MeetingDelivery[]
  /** The delivery whose turn is running. */
  inTurn: MeetingDelivery | null
  settleUntil: number
}

export class MeetingOutbox {
  private readonly queues = new Map<string, Queue>()

  constructor(private readonly deps: MeetingOutboxDeps) {}

  enqueue(tabId: string, delivery: MeetingDelivery): void {
    const queue = this.queues.get(tabId) ?? { items: [], inTurn: null, settleUntil: 0 }
    this.queues.set(tabId, queue)
    queue.items.push(delivery)
  }

  cancel(meetingId: string, tabId?: string): void {
    for (const [id, queue] of this.queues) {
      if (tabId !== undefined && id !== tabId) continue
      queue.items = queue.items.filter((item) => item.meetingId !== meetingId)
    }
  }

  /** The delivery whose turn is running in this session, if any. */
  inTurn(tabId: string): MeetingDelivery | null {
    return this.queues.get(tabId)?.inTurn ?? null
  }

  /** The session's prompt finished (it went idle). Returns the delivery that turn answered. */
  turnEnded(tabId: string): MeetingDelivery | null {
    const queue = this.queues.get(tabId)
    if (!queue) return null
    const delivery = queue.inTurn
    queue.inTurn = null
    return delivery
  }

  forget(tabId: string): void {
    this.queues.delete(tabId)
  }

  hasWork(): boolean {
    for (const queue of this.queues.values()) if (queue.items.length) return true
    return false
  }

  /** Recipients that could receive an item on the next pump; no inventory work for running turns or settling commands. */
  readyTabs(): string[] {
    return [...this.queues].filter(([, queue]) => queue.items.length && !queue.inTurn && this.deps.now() >= queue.settleUntil)
      .map(([tabId]) => tabId)
  }

  /** Tries the next item of every session that is free; returns true when something is still waiting. */
  pump(): boolean {
    for (const [tabId, queue] of this.queues) {
      while (queue.items.length && !queue.inTurn && this.deps.now() >= queue.settleUntil) {
        const delivery = queue.items[0]!
        if (delivery.kind === 'add-dir') {
          if (!this.deps.sendCommand(tabId, `/add-dir ${delivery.text}`)) break
          queue.items.shift()
          queue.settleUntil = this.deps.now() + COMMAND_SETTLE_MS
          break
        }
        const result = this.deps.sendTask(tabId, delivery.text)
        if (result.result === 'busy') break
        queue.items.shift()
        if (result.result === 'refused') { this.deps.refused(tabId, delivery, result.message); continue }
        queue.inTurn = delivery
        this.deps.sent(tabId, delivery)
      }
      if (!queue.items.length && !queue.inTurn) this.queues.delete(tabId)
    }
    return this.hasWork()
  }
}
