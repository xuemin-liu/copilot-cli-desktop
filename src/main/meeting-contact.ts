import type { MeetingView } from './meeting.js'

/**
 * Whether an outside agent still takes part. The desktop cannot wake one: it gets its messages only by asking, so an agent
 * that ended its turn looks like one that is thinking, until the person is told. Nothing here changes the meeting: a late
 * answer still counts, and the person decides what to do. No Node imports: the meeting bar reads this too.
 */

/**
 * `lastSeenAt`: its latest request of any kind, not its latest poll. `waiting`: a `next` of its is open now. `holding`: it was
 * handed a message and has not answered, so it may be working on it for a long time.
 */
export interface GuestContact { lastSeenAt: number | null; waiting: boolean; holding: boolean }

/** A heuristic, not a measured limit: an agent polling in a loop asks again within seconds of a wait ending. */
export const GUEST_QUIET_MS = 3 * 60_000

/** No request for a while and none open, whatever it may be doing. */
export function guestQuiet(contact: GuestContact, now: number, notBefore = 0): boolean {
  return contact.lastSeenAt !== null && !contact.waiting && now - Math.max(contact.lastSeenAt, notBefore) > GUEST_QUIET_MS
}

/** It should be asking for its next message and is not. One holding a message is left to its round's deadline, or its answer. */
export function guestStalled(contact: GuestContact, now: number, notBefore = 0): boolean {
  return !contact.holding && guestQuiet(contact, now, notBefore)
}

export interface GuestStall { meetingId: string; seatId: string; title: string; host: boolean }

/**
 * Who the person should hear about. `notBefore`: when the desktop started, since every agent looks quiet until it reconnects.
 * Not a paused meeting, which already waits for the person, nor a host alone with nobody to answer yet.
 */
export function meetingStalls(meetings: readonly MeetingView[], now: number, notBefore = 0): GuestStall[] {
  return meetings.flatMap((meeting) => {
    if (meeting.stage === 'closed' || meeting.stage === 'paused') return []
    if (meeting.stage === 'waiting' && meeting.participants.length === 0) return []
    const stalls: GuestStall[] = []
    if (meeting.hostGuest && guestStalled(meeting.hostGuest, now, notBefore)) stalls.push({ meetingId: meeting.id, seatId: meeting.hostTabId, title: meeting.hostTitle, host: true })
    for (const participant of meeting.participants) {
      if (participant.guest && guestStalled(participant.guest, now, notBefore)) stalls.push({ meetingId: meeting.id, seatId: participant.tabId, title: participant.title, host: false })
    }
    return stalls
  })
}

/** One notice per quiet spell: a seat is told about once, and again only after it was heard from in between. */
export class GuestStallNotices {
  private noticed = new Set<string>()

  /** The stalls not told about yet. Call it with all of them: a seat missing from the list is over its spell. */
  take(stalls: readonly GuestStall[]): GuestStall[] {
    const key = (stall: GuestStall): string => `${stall.meetingId}/${stall.seatId}`
    const fresh = stalls.filter((stall) => !this.noticed.has(key(stall)))
    this.noticed = new Set(stalls.map(key))
    return fresh
  }
}

/** Whom the meeting waits for, in the words of the party asking. From its state only: the desktop cannot know what anyone is doing. */
export function meetingWaitingOn(meeting: MeetingView, partyId: string): string {
  const host = partyId === meeting.hostTabId ? 'your answer' : `the host, ${meeting.hostTitle}`
  switch (meeting.stage) {
    case 'waiting': return meeting.participants.length ? `Waiting for ${host}.` : 'Nobody has joined yet.'
    case 'host': return `Waiting for ${host}.`
    case 'paused': return 'The meeting is paused; the person decides whether it goes on.'
    case 'closed': return 'The meeting is closed.'
    case 'reviewing': {
      const others = meeting.waitingFor.filter((id) => id !== partyId)
        .map((id) => meeting.participants.find((participant) => participant.tabId === id)?.title ?? id)
      return others.length ? `Waiting for ${others.join(', ')}.` : 'Waiting for the round to finish.'
    }
  }
}
