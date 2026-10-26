import { randomInt } from 'node:crypto'
import { join } from 'node:path'
import {
  MAX_MEETING_PATCH_CHARS,
  MAX_MEETING_POST_CHARS,
  MAX_MEETING_REPLY_CHARS,
  agreedMessage,
  cleanTopic,
  digestMessage,
  parseVote,
  partyLabel,
  postMessage,
  reminderMessage,
  repliesDocument,
  roundPaths,
  transcriptEntry,
  voteMessage,
  type MeetingParty,
  type MeetingReplyView,
  type MeetingVote,
} from './meeting-messages.js'
import { MAX_MEETING_MAX_ROUNDS } from './meeting-settings.js'

/**
 * Review meetings between sessions (docs/session-meeting-plan.md). One host session owns the material; participants review
 * it in rounds. The desktop delivers each host post to every participant, collects their replies, and hands them to the host
 * in one message, until the host proposes to close and everyone agrees, the host ends it, or the person stops it.
 *
 * This class is the state machine only. What it asks for (typing a message into a session, writing a file, telling the
 * renderer) goes through `MeetingEffects`, so it runs on a fake clock in tests.
 */

/** No 0/O, 1/I/L: an id the person reads in one session and types in another. */
export const MEETING_ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export const MEETING_ID_PATTERN = new RegExp(`^[${MEETING_ID_ALPHABET}]{4}$`)

export const MAX_MEETING_PARTICIPANTS = 8
/** Rounds added by the person's "More rounds" when a meeting pauses at its cap. */
export const MEETING_EXTRA_ROUNDS = 3
const MAX_TRANSCRIPT_CHARS = 4 * 1024 * 1024
/** A closed meeting stays listed (for its transcript) this long. */
const CLOSED_MEETING_LINGER_MS = 30 * 60_000

/**
 * - `waiting`: open, nobody has joined (or everyone left); the opening post waits for the first participant.
 * - `reviewing`: a round was delivered to the participants; their replies are being collected.
 * - `host`: the replies went to the host; the meeting waits for its next post, a vote proposal, or the end.
 * - `paused`: the round cap was reached or the host did not answer; the person decides.
 * - `closed`: over; kept for a while so its transcript can be opened.
 */
export type MeetingStage = 'waiting' | 'reviewing' | 'host' | 'paused' | 'closed'
export type MeetingOutcome = 'agreed' | 'ended' | 'stopped' | 'host-left'
export type MeetingRole = 'host' | 'participant'
export type MeetingDeliveryKind = 'add-dir' | 'post' | 'vote' | 'digest' | 'agreed' | 'reminder'

export interface MeetingParticipantView { tabId: string; title: string; replied: boolean }

export interface MeetingView {
  id: string
  hostTabId: string
  hostTitle: string
  topic: string
  stage: MeetingStage
  round: number
  maxRounds: number
  vote: boolean
  participants: MeetingParticipantView[]
  /** Tab ids whose reply the round waits for. */
  waitingFor: string[]
  pauseReason: 'round-limit' | 'host-silent' | null
  outcome: MeetingOutcome | null
  folder: string
}

export interface MeetingDelivery { meetingId: string; kind: MeetingDeliveryKind; text: string }

export interface MeetingEffects {
  /** Queue a message (or, for `add-dir`, a command) for the session; it is typed when the session can take it. */
  deliver(tabId: string, delivery: MeetingDelivery): void
  /** Drop anything not yet typed for this meeting, in one session or in all of them. */
  cancel(meetingId: string, tabId?: string): void
  write(meetingId: string, path: string, text: string): void
  changed(): void
  notify(meetingId: string, message: string): void
}

export interface MeetingTimers {
  now(): number
  set(callback: () => void, ms: number): () => void
}

export const realMeetingTimers: MeetingTimers = {
  now: () => Date.now(),
  set: (callback, ms) => { const timer = setTimeout(callback, ms); timer.unref?.(); return () => clearTimeout(timer) },
}

export interface MeetingSettings { maxRounds: number; roundTimeoutMinutes: number }

export class MeetingError extends Error {
  override name = 'MeetingError'
}

interface Participant extends MeetingParty { tabId: string; joinedRound: number }

interface Reply { text: string | null; vote: MeetingVote | null }

interface Meeting {
  id: string
  folder: string
  topic: string
  host: MeetingParty & { tabId: string }
  participants: Map<string, Participant>
  stage: MeetingStage
  round: number
  maxRounds: number
  vote: boolean
  post: string
  hasChanges: boolean
  replies: Map<string, Reply>
  awaiting: Set<string>
  late: MeetingReplyView[]
  /** A post the host made past the round cap, delivered if the person allows more rounds. */
  held: { kind: 'round' | 'propose-close'; text: string; changes: string | null } | null
  pauseReason: 'round-limit' | 'host-silent' | null
  remindedHost: boolean
  outcome: MeetingOutcome | null
  closedAt: number | null
  cancelTimer: (() => void) | null
  transcript: string
}

export interface StartMeeting { topic: string; post: string; changes: string | null }

export class MeetingHub {
  private readonly meetings = new Map<string, Meeting>()

  constructor(
    /** Read when a meeting starts: the app's data folder is known only once Electron is set up. */
    private readonly root: () => string,
    private readonly effects: MeetingEffects,
    private readonly settings: () => MeetingSettings,
    private readonly timers: MeetingTimers = realMeetingTimers,
    private readonly newId: (taken: (id: string) => boolean) => string = randomMeetingId,
  ) {}

  /** The open (not closed) meeting a session hosts or takes part in. */
  meetingOf(tabId: string): { id: string; role: MeetingRole } | null {
    for (const meeting of this.meetings.values()) {
      if (meeting.stage === 'closed') continue
      if (meeting.host.tabId === tabId) return { id: meeting.id, role: 'host' }
      if (meeting.participants.has(tabId)) return { id: meeting.id, role: 'participant' }
    }
    return null
  }

  isOpen(id: string): boolean {
    const meeting = this.meetings.get(id)
    return meeting !== undefined && meeting.stage !== 'closed'
  }

  folderOf(id: string): string | null {
    return this.meetings.get(id)?.folder ?? null
  }

  views(): MeetingView[] {
    this.forgetOldMeetings()
    return [...this.meetings.values()].map((meeting) => ({
      id: meeting.id,
      hostTabId: meeting.host.tabId,
      hostTitle: meeting.host.title,
      topic: meeting.topic,
      stage: meeting.stage,
      round: meeting.round,
      maxRounds: meeting.maxRounds,
      vote: meeting.vote,
      participants: [...meeting.participants.values()].map((participant) => ({
        tabId: participant.tabId, title: participant.title, replied: meeting.replies.has(participant.tabId),
      })),
      waitingFor: [...meeting.awaiting],
      pauseReason: meeting.pauseReason,
      outcome: meeting.outcome,
      folder: meeting.folder,
    }))
  }

  start(host: MeetingParty & { tabId: string }, request: StartMeeting): MeetingView {
    const current = this.meetingOf(host.tabId)
    if (current) throw new MeetingError(`This session is already in meeting ${current.id}. End it first.`)
    const post = bound(request.post, MAX_MEETING_POST_CHARS)
    if (!post.trim()) throw new MeetingError('A meeting needs something to discuss: pass -File with the plan or notes.')
    const id = this.newId((candidate) => this.meetings.has(candidate))
    const meeting: Meeting = {
      id,
      folder: join(this.root(), id),
      topic: cleanTopic(request.topic),
      host: { ...host },
      participants: new Map(),
      stage: 'waiting',
      round: 1,
      maxRounds: this.settings().maxRounds,
      vote: false,
      post,
      hasChanges: false,
      replies: new Map(),
      awaiting: new Set(),
      late: [],
      held: null,
      pauseReason: null,
      remindedHost: false,
      outcome: null,
      closedAt: null,
      cancelTimer: null,
      transcript: `# Meeting ${id}\n\nHost: session ${partyLabel(host)}\nTopic: ${cleanTopic(request.topic) || 'not given'}\n`,
    }
    this.meetings.set(id, meeting)
    this.writePost(meeting, 'Opening post', request.changes)
    this.effects.deliver(host.tabId, { meetingId: id, kind: 'add-dir', text: meeting.folder })
    this.effects.changed()
    return this.view(meeting)
  }

  join(participant: MeetingParty & { tabId: string }, id: string): MeetingView {
    const meeting = this.meetings.get(id)
    if (!meeting || meeting.stage === 'closed') throw new MeetingError(`There is no open meeting ${id}.`)
    if (meeting.host.tabId === participant.tabId) throw new MeetingError(`This session hosts meeting ${id}.`)
    if (meeting.participants.has(participant.tabId)) return this.view(meeting)
    const current = this.meetingOf(participant.tabId)
    if (current) throw new MeetingError(`This session is already in meeting ${current.id}.`)
    if (meeting.participants.size >= MAX_MEETING_PARTICIPANTS) throw new MeetingError(`Meeting ${id} already has ${MAX_MEETING_PARTICIPANTS} participants.`)
    const joinedLate = meeting.round > 1 || meeting.stage !== 'waiting'
    meeting.participants.set(participant.tabId, { ...participant, joinedRound: meeting.round })
    this.appendTranscript(meeting, `Session ${partyLabel(participant)} joined`, `In round ${meeting.round}.`)
    this.effects.deliver(participant.tabId, { meetingId: id, kind: 'add-dir', text: meeting.folder })
    if (meeting.stage === 'waiting') {
      this.openRound(meeting)
    } else {
      // Mid-round it answers this round; otherwise (host thinking, paused) its reply joins the next digest as a late one.
      if (meeting.stage === 'reviewing') meeting.awaiting.add(participant.tabId)
      this.deliverRound(meeting, participant.tabId, joinedLate)
    }
    this.effects.changed()
    return this.view(meeting)
  }

  /** The host's next round, or its proposal to close (a vote). */
  post(hostTabId: string, kind: 'round' | 'propose-close', text: string, changes: string | null): string {
    const meeting = this.hostedBy(hostTabId)
    const post = bound(text, MAX_MEETING_POST_CHARS)
    if (!post.trim()) throw new MeetingError('Pass -File with what to post.')
    if (meeting.stage === 'reviewing') throw new MeetingError('The reviewers have not all answered yet. End your turn; their replies arrive as your next message.')
    if (meeting.stage === 'paused') throw new MeetingError('The meeting is paused; the person decides whether it continues.')
    if (meeting.stage === 'waiting') {
      if (kind === 'propose-close') throw new MeetingError('Nobody has joined yet, so there is nobody to agree.')
      meeting.post = post
      this.writePost(meeting, 'Opening post (revised before anyone joined)', changes)
      this.effects.changed()
      return `Nobody has joined meeting ${meeting.id} yet; the revised post will be the first thing they see. End your turn.`
    }
    if (meeting.round >= meeting.maxRounds) {
      meeting.held = { kind, text: post, changes }
      this.pause(meeting, 'round-limit')
      return `Meeting ${meeting.id} reached its limit of ${meeting.maxRounds} rounds. The person decides whether it continues; end your turn.`
    }
    this.nextRound(meeting, kind, post, changes)
    return `Sent round ${meeting.round} to ${meeting.participants.size} reviewer${meeting.participants.size === 1 ? '' : 's'}. Their replies arrive as your next message; end your turn now.`
  }

  /** The host closes the meeting without a vote. */
  end(hostTabId: string): void {
    this.close(this.hostedBy(hostTabId), 'ended')
  }

  /** The person stops a meeting from the desktop. */
  stop(id: string): void {
    const meeting = this.meetings.get(id)
    if (meeting && meeting.stage !== 'closed') this.close(meeting, 'stopped')
  }

  /** The person lets a paused meeting go on. */
  resume(id: string): void {
    const meeting = this.meetings.get(id)
    if (!meeting || meeting.stage !== 'paused') return
    const reason = meeting.pauseReason
    meeting.pauseReason = null
    if (reason === 'round-limit') {
      meeting.maxRounds = Math.min(MAX_MEETING_MAX_ROUNDS, meeting.maxRounds + MEETING_EXTRA_ROUNDS)
      const held = meeting.held
      meeting.held = null
      if (held && meeting.participants.size) { this.nextRound(meeting, held.kind, held.text, held.changes); return }
      meeting.stage = meeting.participants.size ? 'host' : 'waiting'
    } else {
      meeting.stage = 'host'
      meeting.remindedHost = true
      this.effects.deliver(meeting.host.tabId, { meetingId: meeting.id, kind: 'reminder', text: reminderMessage(meeting.id) })
    }
    this.effects.changed()
  }

  /**
   * A turn the desktop started in this session ended. For a participant its reply is the turn's final answer; for the host it
   * means the turn that received the replies (or a reminder) is over.
   */
  turnCompleted(tabId: string, meetingId: string, kind: MeetingDeliveryKind, reply: string): void {
    const meeting = this.meetings.get(meetingId)
    if (!meeting || meeting.stage === 'closed') return
    if (meeting.host.tabId === tabId) {
      if ((kind === 'digest' || kind === 'reminder') && meeting.stage === 'host') this.hostSilent(meeting)
      return
    }
    const participant = meeting.participants.get(tabId)
    if (!participant || (kind !== 'post' && kind !== 'vote')) return
    const text = bound(reply.trim(), MAX_MEETING_REPLY_CHARS) || '(an empty reply)'
    const answersThisRound = meeting.stage === 'reviewing' && meeting.awaiting.has(tabId) && (kind === 'vote') === meeting.vote
    this.appendTranscript(meeting, `Round ${meeting.round}: ${partyLabel(participant)}${answersThisRound ? '' : ' (late)'}`, text)
    if (!answersThisRound) {
      meeting.late.push({ title: participant.title, folder: participant.folder, text })
      return
    }
    meeting.awaiting.delete(tabId)
    meeting.replies.set(tabId, { text, vote: meeting.vote ? parseVote(text) : null })
    if (meeting.awaiting.size === 0) this.finishRound(meeting)
    else this.effects.changed()
  }

  /** The session closed or its process ended for good. */
  leave(tabId: string): void {
    for (const meeting of this.meetings.values()) {
      if (meeting.stage === 'closed') continue
      if (meeting.host.tabId === tabId) { this.close(meeting, 'host-left'); continue }
      const participant = meeting.participants.get(tabId)
      if (!participant) continue
      meeting.participants.delete(tabId)
      meeting.replies.delete(tabId)
      this.effects.cancel(meeting.id, tabId)
      this.appendTranscript(meeting, `Session ${partyLabel(participant)} left`, `In round ${meeting.round}.`)
      const wasAwaited = meeting.awaiting.delete(tabId)
      if (meeting.participants.size === 0 && meeting.stage === 'reviewing') {
        // Nobody left to answer: the round starts over for whoever joins next.
        meeting.cancelTimer?.()
        meeting.cancelTimer = null
        meeting.replies.clear()
        meeting.stage = 'waiting'
      } else if (wasAwaited && meeting.awaiting.size === 0 && meeting.stage === 'reviewing') {
        this.finishRound(meeting)
        continue
      }
      this.effects.changed()
    }
  }

  dispose(): void {
    for (const meeting of this.meetings.values()) meeting.cancelTimer?.()
    this.meetings.clear()
  }

  private hostedBy(tabId: string): Meeting {
    for (const meeting of this.meetings.values()) {
      if (meeting.stage !== 'closed' && meeting.host.tabId === tabId) return meeting
    }
    throw new MeetingError('This session does not host an open meeting. Start one first.')
  }

  private view(meeting: Meeting): MeetingView {
    return this.views().find((view) => view.id === meeting.id)!
  }

  private nextRound(meeting: Meeting, kind: 'round' | 'propose-close', post: string, changes: string | null): void {
    meeting.round++
    meeting.vote = kind === 'propose-close'
    meeting.post = post
    meeting.remindedHost = false
    this.writePost(meeting, meeting.vote ? `Round ${meeting.round}: the host proposes to close` : `Round ${meeting.round}: host`, meeting.vote ? null : changes)
    this.openRound(meeting)
    this.effects.changed()
  }

  private openRound(meeting: Meeting): void {
    meeting.stage = 'reviewing'
    meeting.replies.clear()
    meeting.awaiting = new Set(meeting.participants.keys())
    meeting.cancelTimer?.()
    meeting.cancelTimer = this.timers.set(() => this.timeOut(meeting), this.settings().roundTimeoutMinutes * 60_000)
    for (const tabId of meeting.participants.keys()) this.deliverRound(meeting, tabId, false)
  }

  private deliverRound(meeting: Meeting, tabId: string, joinedLate: boolean): void {
    const host = meeting.host
    const text = meeting.vote
      ? voteMessage({ id: meeting.id, round: meeting.round, host, summary: meeting.post, folder: meeting.folder, joinedLate })
      : postMessage({ id: meeting.id, round: meeting.round, topic: meeting.topic, host, post: meeting.post, folder: meeting.folder, hasChanges: meeting.hasChanges, previousReplies: meeting.round > 1, joinedLate })
    this.effects.deliver(tabId, { meetingId: meeting.id, kind: meeting.vote ? 'vote' : 'post', text })
  }

  private timeOut(meeting: Meeting): void {
    meeting.cancelTimer = null
    if (meeting.stage !== 'reviewing') return
    for (const tabId of meeting.awaiting) this.effects.cancel(meeting.id, tabId)
    this.finishRound(meeting)
  }

  private finishRound(meeting: Meeting): void {
    meeting.cancelTimer?.()
    meeting.cancelTimer = null
    const replies: MeetingReplyView[] = [...meeting.participants.values()].map((participant) => {
      const reply = meeting.replies.get(participant.tabId)
      return { title: participant.title, folder: participant.folder, text: reply?.text ?? null, vote: reply?.vote ?? null }
    })
    meeting.awaiting.clear()
    const late = meeting.late
    meeting.late = []
    const paths = roundPaths(meeting.folder, meeting.round)
    this.effects.write(meeting.id, paths.replies, repliesDocument(meeting.id, meeting.round, replies, late))
    if (meeting.vote && replies.length > 0 && replies.every((reply) => reply.vote === 'agree')) {
      this.effects.deliver(meeting.host.tabId, { meetingId: meeting.id, kind: 'agreed', text: agreedMessage(meeting.id, meeting.round, replies.length, meeting.folder) })
      this.close(meeting, 'agreed')
      return
    }
    meeting.stage = 'host'
    meeting.remindedHost = false
    this.effects.deliver(meeting.host.tabId, {
      meetingId: meeting.id, kind: 'digest',
      text: digestMessage({ id: meeting.id, round: meeting.round, vote: meeting.vote, folder: meeting.folder, replies, late }),
    })
    this.effects.changed()
  }

  private hostSilent(meeting: Meeting): void {
    if (!meeting.remindedHost) {
      meeting.remindedHost = true
      this.effects.deliver(meeting.host.tabId, { meetingId: meeting.id, kind: 'reminder', text: reminderMessage(meeting.id) })
      return
    }
    this.pause(meeting, 'host-silent')
  }

  private pause(meeting: Meeting, reason: 'round-limit' | 'host-silent'): void {
    meeting.stage = 'paused'
    meeting.pauseReason = reason
    this.effects.notify(meeting.id, reason === 'round-limit'
      ? `Meeting ${meeting.id} reached ${meeting.maxRounds} rounds. Allow ${MEETING_EXTRA_ROUNDS} more, or end it.`
      : `Meeting ${meeting.id} is paused: its host did not answer the round.`)
    this.effects.changed()
  }

  private close(meeting: Meeting, outcome: MeetingOutcome): void {
    meeting.cancelTimer?.()
    meeting.cancelTimer = null
    meeting.stage = 'closed'
    meeting.outcome = outcome
    meeting.closedAt = this.timers.now()
    meeting.awaiting.clear()
    meeting.held = null
    // The agreed notice to the host was queued just before; everything else not yet typed is dropped.
    for (const tabId of meeting.participants.keys()) this.effects.cancel(meeting.id, tabId)
    if (outcome !== 'agreed') this.effects.cancel(meeting.id, meeting.host.tabId)
    const how: Record<MeetingOutcome, string> = {
      agreed: 'Everyone agreed; the meeting is closed.',
      ended: 'The host ended the meeting.',
      stopped: 'The person stopped the meeting.',
      'host-left': 'The host session closed.',
    }
    this.appendTranscript(meeting, 'Closed', how[outcome])
    this.effects.notify(meeting.id, `Meeting ${meeting.id}: ${how[outcome]}`)
    this.effects.changed()
  }

  private writePost(meeting: Meeting, heading: string, changes: string | null): void {
    const paths = roundPaths(meeting.folder, meeting.round)
    meeting.hasChanges = changes !== null && changes.trim().length > 0
    this.effects.write(meeting.id, paths.post, meeting.post)
    if (meeting.hasChanges) this.effects.write(meeting.id, paths.changes, bound(changes!, MAX_MEETING_PATCH_CHARS, '\n# The patch stops here: it exceeded the meeting limit.\n'))
    this.appendTranscript(meeting, heading, meeting.post + (meeting.hasChanges ? `\n\n(Changes: ${paths.changes})` : ''))
  }

  private appendTranscript(meeting: Meeting, heading: string, body: string): void {
    if (meeting.transcript.length >= MAX_TRANSCRIPT_CHARS) return
    meeting.transcript = bound(meeting.transcript + transcriptEntry(heading, body), MAX_TRANSCRIPT_CHARS, '\n\n(The transcript stops here: it reached its size limit.)\n')
    this.effects.write(meeting.id, roundPaths(meeting.folder, meeting.round).transcript, meeting.transcript)
  }

  private forgetOldMeetings(): void {
    const now = this.timers.now()
    for (const [id, meeting] of this.meetings) {
      if (meeting.closedAt !== null && now - meeting.closedAt > CLOSED_MEETING_LINGER_MS) this.meetings.delete(id)
    }
  }
}

function bound(text: string, limit: number, note = ''): string {
  return text.length <= limit ? text : text.slice(0, limit) + note
}

export function randomMeetingId(taken: (id: string) => boolean): string {
  for (;;) {
    let id = ''
    for (let index = 0; index < 4; index++) id += MEETING_ID_ALPHABET[randomInt(MEETING_ID_ALPHABET.length)]
    if (!taken(id)) return id
  }
}

const JOIN_REQUEST = /\bjoin\b[^\n]{0,40}?\b(?:meeting|chat)\b\s*(?:id\s*)?[#:]?\s*([a-z0-9]{4})\b/i

/** The meeting id in a message the person typed asking to join one, or null. */
export function joinRequestId(text: string): string | null {
  const id = JOIN_REQUEST.exec(text)?.[1]?.toUpperCase()
  return id && MEETING_ID_PATTERN.test(id) ? id : null
}
