import { randomInt } from 'node:crypto'
import { join } from 'node:path'
import {
  MAX_MEETING_PATCH_CHARS,
  MAX_MEETING_POST_CHARS,
  MAX_MEETING_REPLY_CHARS,
  agreedMessage,
  cleanRole,
  cleanTopic,
  digestMessage,
  discussionMessage,
  parseVote,
  partyLabel,
  postMessage,
  reminderMessage,
  repliesDocument,
  roundPaths,
  shareablePatch,
  transcriptEntry,
  voteMessage,
  type MeetingParty,
  type MeetingReplyView,
  type MeetingVote,
} from './meeting-messages.js'
import { MAX_MEETING_MAX_ROUNDS } from './meeting-settings.js'
import type { MeetingUsage } from './meeting-turns.js'

/**
 * Review meetings between sessions (docs/session-meeting-plan.md). One host session owns the material; participants review
 * it in rounds. The desktop delivers each host post to every participant, collects their replies, and hands them to the host
 * in one message, until the host proposes to close and everyone agrees, the host ends it, or the person stops it.
 *
 * This class is the state machine only. What it asks for (typing a message into a session, writing a file, telling the
 * renderer) goes through `MeetingEffects`, so it runs on a fake clock in tests.
 *
 * An open meeting is saved to `meeting.json` in its folder after every change, with its sessions named by their Copilot
 * session ids (tab ids are new on every launch). After a restart `restore` maps them back to the restored tabs and sends
 * again whatever a session had been given and not finished answering.
 */

/** No 0/O, 1/I/L: an id the person reads in one session and types in another. */
export const MEETING_ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export const MEETING_ID_PATTERN = new RegExp(`^[${MEETING_ID_ALPHABET}]{4}$`)

export const MAX_MEETING_PARTICIPANTS = 8
/** Rounds added by the person's "More rounds" when a meeting pauses at its cap. */
export const MEETING_EXTRA_ROUNDS = 3
/** Copilot CLI counts usage in nano AI units; its `--max-ai-credits` multiplies credits by this (`NANO_AIU_PER_AIU`). */
export const NANO_AIU_PER_AI_CREDIT = 1e9
export const MEETING_STATE_FILE = 'meeting.json'
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
export type MeetingDeliveryKind = 'add-dir' | 'post' | 'vote' | 'discussion' | 'digest' | 'agreed' | 'reminder'
const STAGES: readonly MeetingStage[] = ['waiting', 'reviewing', 'host', 'paused', 'closed']
const OUTCOMES: readonly MeetingOutcome[] = ['agreed', 'ended', 'stopped', 'host-left']
const DELIVERY_KINDS: readonly MeetingDeliveryKind[] = ['post', 'vote', 'discussion', 'digest', 'agreed', 'reminder']

/** `guest`: an outside agent (meeting-guests.ts), whose `tabId` is its seat id; filled in by main, which knows the seats. */
export interface MeetingParticipantView { tabId: string; title: string; role: string | null; replied: boolean; guest?: { lastSeenAt: number | null } }

/** An outside agent invited to the meeting that has not asked for its first message yet. */
export interface MeetingInviteView { id: string; name: string; role: string | null }

/** What the meeting's sessions used since they joined it. */
export interface MeetingCost { aiCredits: number; premiumRequests: number }

export interface MeetingView {
  id: string
  hostTabId: string
  hostTitle: string
  topic: string
  stage: MeetingStage
  round: number
  maxRounds: number
  vote: boolean
  /** The round's reviews are in and the reviewers are answering each other. */
  discussing: boolean
  participants: MeetingParticipantView[]
  /** Tab ids whose reply the round waits for. */
  waitingFor: string[]
  pauseReason: 'round-limit' | 'host-silent' | null
  outcome: MeetingOutcome | null
  folder: string
  cost: MeetingCost
  /** Filled in by main. */
  invited?: MeetingInviteView[]
}

/** `round` is the round the message belongs to: a reply counts only for that round, however late its turn ends. */
export interface MeetingDelivery { meetingId: string; round: number; kind: MeetingDeliveryKind; text: string }

export interface MeetingEffects {
  /** Queue a message (or, for `add-dir`, a command) for the session; it is typed when the session can take it. */
  deliver(tabId: string, delivery: MeetingDelivery): void
  /** Drop anything not yet typed for this meeting, in one session or in all of them. */
  cancel(meetingId: string, tabId?: string): void
  write(meetingId: string, path: string, text: string): void
  changed(): void
  notify(meetingId: string, message: string): void
  /** The Copilot session id of a tab now (an outside agent's seat id for a guest), which is what a saved meeting remembers it by. */
  sessionIdOf(tabId: string): string | null
  /** A meeting folder by that id exists already (an older meeting's, kept for a week): its id is not reused. */
  folderExists?(id: string): boolean
  /**
   * A party the meeting takes out after it lets two rounds in a row time out (an outside agent that stopped polling). A
   * Copilot tab is never taken out: the person sees it and decides.
   */
  dropsWhenSilent?(tabId: string): boolean
  /** A party was taken out for its silence; it is told why. */
  dropped?(tabId: string, message: string): void
}

/** Rounds in a row a party that `dropsWhenSilent` may let time out before it is taken out. */
export const MAX_SILENT_ROUNDS = 2

export interface MeetingTimers {
  now(): number
  set(callback: () => void, ms: number): () => void
}

export const realMeetingTimers: MeetingTimers = {
  now: () => Date.now(),
  set: (callback, ms) => { const timer = setTimeout(callback, ms); timer.unref?.(); return () => clearTimeout(timer) },
}

/** `discussion`: after a review round's replies are in, reviewers answer each other before the host sees them. */
export interface MeetingSettings { maxRounds: number; roundTimeoutMinutes: number; discussion?: boolean }

export class MeetingError extends Error {
  override name = 'MeetingError'
}

/** A session in the meeting; `counted` is its usage totals already added to the meeting's cost. */
type Party = MeetingParty & { tabId: string; counted: MeetingUsage }

/** `missed`: rounds in a row it was waited for and did not answer before the timeout. */
interface Participant extends Party { joinedRound: number; missed: number }

interface Reply { text: string | null; vote: MeetingVote | null }

type HeldPost = { kind: 'round' | 'propose-close'; text: string; changes: string | null }

interface Meeting {
  id: string
  folder: string
  topic: string
  host: Party
  participants: Map<string, Participant>
  stage: MeetingStage
  round: number
  maxRounds: number
  vote: boolean
  post: string
  hasChanges: boolean
  /** The replies being collected: the round's reviews, or while `discussing`, what the reviewers answer each other. */
  replies: Map<string, Reply>
  awaiting: Set<string>
  late: MeetingReplyView[]
  /** The round's reviews are in and each reviewer is answering the others (`reviewed`); the host sees both together. */
  discussing: boolean
  reviewed: MeetingReplyView[] | null
  /** A post the host made past the round cap, delivered if the person allows more rounds. */
  held: HeldPost | null
  pauseReason: 'round-limit' | 'host-silent' | null
  remindedHost: boolean
  outcome: MeetingOutcome | null
  closedAt: number | null
  cancelTimer: (() => void) | null
  transcript: string
  /** What each session was given and has not finished answering; sent again after a restart. */
  outstanding: Map<string, MeetingDelivery>
  cost: MeetingUsage
}

export interface StartMeeting { topic: string; post: string; changes: string | null }

export interface JoinOptions { role?: string | null; usage?: MeetingUsage | null }

/** A session as `restore` needs it: the tab now holding a saved Copilot session. A null folder keeps the saved one. */
export type RestoredParty = MeetingParty & { tabId: string }

interface SavedParty { sessionId: string | null; title: string; folder: string | null; role: string | null; counted: MeetingUsage }

interface SavedMeeting {
  version: 1
  id: string
  topic: string
  host: SavedParty
  participants: Array<SavedParty & { joinedRound: number; reply: Reply | null; awaited: boolean; missed: number }>
  stage: MeetingStage
  round: number
  maxRounds: number
  vote: boolean
  post: string
  hasChanges: boolean
  late: MeetingReplyView[]
  discussing: boolean
  reviewed: MeetingReplyView[] | null
  held: HeldPost | null
  pauseReason: 'round-limit' | 'host-silent' | null
  remindedHost: boolean
  outcome: MeetingOutcome | null
  cost: MeetingUsage
  outstanding: Array<{ sessionId: string; delivery: MeetingDelivery }>
}

const NO_USAGE: MeetingUsage = { nanoAiu: 0, premiumRequests: 0 }

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
      discussing: meeting.discussing,
      participants: [...meeting.participants.values()].map((participant) => ({
        tabId: participant.tabId, title: participant.title, role: participant.role ?? null, replied: meeting.replies.has(participant.tabId),
      })),
      waitingFor: [...meeting.awaiting],
      pauseReason: meeting.pauseReason,
      outcome: meeting.outcome,
      folder: meeting.folder,
      cost: { aiCredits: meeting.cost.nanoAiu / NANO_AIU_PER_AI_CREDIT, premiumRequests: meeting.cost.premiumRequests },
    }))
  }

  start(host: MeetingParty & { tabId: string }, request: StartMeeting, usage: MeetingUsage | null = null): MeetingView {
    const current = this.meetingOf(host.tabId)
    if (current) throw new MeetingError(`This session is already in meeting ${current.id}. End it first.`)
    const post = bound(request.post, MAX_MEETING_POST_CHARS)
    if (!post.trim()) throw new MeetingError('A meeting needs something to discuss: pass -File with the plan or notes.')
    const id = this.newId((candidate) => this.meetings.has(candidate) || this.effects.folderExists?.(candidate) === true)
    const meeting: Meeting = {
      id,
      folder: join(this.root(), id),
      topic: cleanTopic(request.topic),
      host: { tabId: host.tabId, title: host.title, folder: host.folder, role: null, counted: usage ?? NO_USAGE },
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
      discussing: false,
      reviewed: null,
      held: null,
      pauseReason: null,
      remindedHost: false,
      outcome: null,
      closedAt: null,
      cancelTimer: null,
      transcript: `# Meeting ${id}\n\nHost: session ${partyLabel(host)}\nTopic: ${cleanTopic(request.topic) || 'not given'}\n`,
      outstanding: new Map(),
      cost: { ...NO_USAGE },
    }
    this.meetings.set(id, meeting)
    this.writePost(meeting, 'Opening post', request.changes)
    this.send(meeting, host.tabId, 'add-dir', meeting.folder)
    this.changed(meeting)
    return this.view(meeting)
  }

  join(participant: MeetingParty & { tabId: string }, id: string, options: JoinOptions = {}): MeetingView {
    const meeting = this.meetings.get(id)
    if (!meeting || meeting.stage === 'closed') throw new MeetingError(`There is no open meeting ${id}.`)
    if (meeting.host.tabId === participant.tabId) throw new MeetingError(`This session hosts meeting ${id}.`)
    if (meeting.participants.has(participant.tabId)) return this.view(meeting)
    const current = this.meetingOf(participant.tabId)
    if (current) throw new MeetingError(`This session is already in meeting ${current.id}.`)
    if (meeting.participants.size >= MAX_MEETING_PARTICIPANTS) throw new MeetingError(`Meeting ${id} already has ${MAX_MEETING_PARTICIPANTS} participants.`)
    const joinedLate = meeting.round > 1 || meeting.stage !== 'waiting'
    const role = options.role ? cleanRole(options.role) || null : null
    const joined: Participant = { tabId: participant.tabId, title: participant.title, folder: participant.folder, role, counted: options.usage ?? NO_USAGE, joinedRound: meeting.round, missed: 0 }
    meeting.participants.set(participant.tabId, joined)
    this.appendTranscript(meeting, `Session ${partyLabel(joined)} joined`, `In round ${meeting.round}.`)
    this.send(meeting, participant.tabId, 'add-dir', meeting.folder)
    if (meeting.stage === 'waiting') {
      this.openRound(meeting)
    } else {
      // Mid-round it answers this round; otherwise (host thinking, paused) its reply joins the next digest as a late one.
      // During a discussion it has no review for the others to answer: its review joins the next digest as a late one.
      if (meeting.stage === 'reviewing' && !meeting.discussing) meeting.awaiting.add(participant.tabId)
      this.deliverRound(meeting, participant.tabId, joinedLate)
    }
    this.changed(meeting)
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
      this.changed(meeting)
      return `Nobody has joined meeting ${meeting.id} yet; the revised post will be the first thing they see. End your turn.`
    }
    if (meeting.round >= meeting.maxRounds) {
      // Saved with the meeting, in the folder every reviewer can read: filtered like any shared patch before it is kept.
      meeting.held = { kind, text: post, changes: changes === null ? null : sharedChanges(changes) }
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
      this.send(meeting, meeting.host.tabId, 'reminder', reminderMessage(meeting.id))
    }
    this.changed(meeting)
  }

  /**
   * A turn the desktop started in this session ended. For a participant its reply is the turn's final answer; for the host it
   * means the turn that received the replies (or a reminder) is over. A reply to an earlier round (its turn outlasted that
   * round's timeout) never counts for the current one, even of the same kind: it joins the next digest as a late reply.
   */
  turnCompleted(tabId: string, delivery: MeetingDelivery, reply: string): void {
    const { kind } = delivery
    const meeting = this.meetings.get(delivery.meetingId)
    if (!meeting || meeting.stage === 'closed') return
    const outstanding = meeting.outstanding.get(tabId)
    if (outstanding && outstanding.round === delivery.round && outstanding.kind === kind) meeting.outstanding.delete(tabId)
    if (meeting.host.tabId === tabId) {
      if ((kind === 'digest' || kind === 'reminder') && meeting.stage === 'host' && delivery.round === meeting.round) this.hostSilent(meeting)
      else this.changed(meeting)
      return
    }
    const participant = meeting.participants.get(tabId)
    if (!participant || (kind !== 'post' && kind !== 'vote' && kind !== 'discussion')) return
    const text = bound(reply.trim(), MAX_MEETING_REPLY_CHARS) || '(an empty reply)'
    const expected: MeetingDeliveryKind = meeting.discussing ? 'discussion' : meeting.vote ? 'vote' : 'post'
    const answersThisRound = meeting.stage === 'reviewing' && meeting.awaiting.has(tabId) && delivery.round === meeting.round && kind === expected
    const heading = `Round ${delivery.round}${kind === 'discussion' ? ' discussion' : ''}: ${partyLabel(participant)}`
    this.appendTranscript(meeting, `${heading}${answersThisRound ? '' : ` (late, read in round ${meeting.round})`}`, text)
    // Any reply, late too, shows it is there: only rounds of true silence count toward being taken out.
    participant.missed = 0
    if (!answersThisRound) {
      meeting.late.push({ title: participant.title, folder: participant.folder, role: participant.role ?? null, text })
      this.changed(meeting)
      return
    }
    meeting.awaiting.delete(tabId)
    meeting.replies.set(tabId, { text, vote: meeting.vote ? parseVote(text) : null })
    if (meeting.awaiting.size === 0) this.finishRound(meeting)
    else this.changed(meeting)
  }

  /**
   * A session's usage totals changed (a `session.usage_checkpoint`). What it used since it was last counted is added to its
   * meeting's cost. Totals that went down started over (a new process), so all of the new value counts.
   */
  usage(tabId: string, totals: MeetingUsage): void {
    for (const meeting of this.meetings.values()) {
      if (meeting.stage === 'closed') continue
      const party = meeting.host.tabId === tabId ? meeting.host : meeting.participants.get(tabId)
      if (!party) continue
      const delta = (now: number, before: number): number => now >= before ? now - before : now
      meeting.cost = {
        nanoAiu: meeting.cost.nanoAiu + delta(totals.nanoAiu, party.counted.nanoAiu),
        premiumRequests: meeting.cost.premiumRequests + delta(totals.premiumRequests, party.counted.premiumRequests),
      }
      party.counted = { ...totals }
      this.changed(meeting)
    }
  }

  /** The session closed or its process ended for good. */
  leave(tabId: string): void {
    for (const meeting of this.meetings.values()) {
      if (meeting.stage === 'closed') continue
      if (meeting.host.tabId === tabId) { this.close(meeting, 'host-left'); continue }
      const participant = meeting.participants.get(tabId)
      if (!participant) continue
      this.removeParticipant(meeting, participant, `Session ${partyLabel(participant)} left`)
    }
  }

  /**
   * Bring back a meeting saved before the app closed. `find` gives the tab now holding a saved Copilot session, or null. A
   * meeting whose host is not back closes; a participant that is not back leaves. Each session gets the meeting folder again
   * and whatever it had been given and not finished answering; a round being reviewed starts its timeout over. Returns the
   * tabs taking part, which the caller starts, or null when nothing was restored.
   */
  restore(saved: unknown, transcript: string, find: (sessionId: string) => RestoredParty | null): string[] | null {
    const state = readSavedMeeting(saved)
    if (!state || state.stage === 'closed' || this.meetings.has(state.id)) return null
    const folder = join(this.root(), state.id)
    const host = state.host.sessionId ? find(state.host.sessionId) : null
    if (!host) {
      const note = transcriptEntry('Closed', 'The host session was not open after the app restarted.')
      this.effects.write(state.id, roundPaths(folder, state.round).transcript, bound(transcript + note, MAX_TRANSCRIPT_CHARS))
      this.effects.write(state.id, join(folder, MEETING_STATE_FILE), JSON.stringify({ ...state, stage: 'closed', outcome: 'host-left', outstanding: [] }))
      return null
    }
    const bySession = new Map<string, string>()
    const meeting: Meeting = {
      id: state.id,
      folder,
      topic: state.topic,
      host: { tabId: host.tabId, title: host.title, folder: host.folder ?? state.host.folder, role: null, counted: state.host.counted },
      participants: new Map(),
      stage: state.stage,
      round: state.round,
      maxRounds: state.maxRounds,
      vote: state.vote,
      post: state.post,
      hasChanges: state.hasChanges,
      replies: new Map(),
      awaiting: new Set(),
      late: state.late,
      discussing: state.discussing,
      reviewed: state.reviewed,
      held: state.held,
      pauseReason: state.pauseReason,
      remindedHost: state.remindedHost,
      outcome: null,
      closedAt: null,
      cancelTimer: null,
      transcript: transcript || `# Meeting ${state.id}\n`,
      outstanding: new Map(),
      cost: state.cost,
    }
    bySession.set(state.host.sessionId!, host.tabId)
    this.meetings.set(meeting.id, meeting)
    this.appendTranscript(meeting, 'Restored', `The app restarted; the meeting goes on in round ${meeting.round}.`)
    const missing: SavedParty[] = []
    for (const entry of state.participants) {
      const tab = entry.sessionId ? find(entry.sessionId) : null
      if (!tab || tab.tabId === host.tabId || meeting.participants.has(tab.tabId)) { missing.push(entry); continue }
      bySession.set(entry.sessionId!, tab.tabId)
      meeting.participants.set(tab.tabId, { tabId: tab.tabId, title: tab.title, folder: tab.folder ?? entry.folder, role: entry.role, counted: entry.counted, joinedRound: entry.joinedRound, missed: entry.missed })
      if (entry.reply) meeting.replies.set(tab.tabId, entry.reply)
      if (entry.awaited && meeting.stage === 'reviewing') meeting.awaiting.add(tab.tabId)
    }
    for (const entry of missing) this.appendTranscript(meeting, `Session ${partyLabel(entry)} left`, 'It was not open after the app restarted.')
    for (const tabId of [host.tabId, ...meeting.participants.keys()]) this.send(meeting, tabId, 'add-dir', meeting.folder)
    for (const { sessionId, delivery } of state.outstanding) {
      const tabId = bySession.get(sessionId)
      if (tabId) this.send(meeting, tabId, delivery.kind, delivery.text, delivery.round)
    }
    if (meeting.stage === 'reviewing') {
      if (meeting.participants.size === 0) this.backToWaiting(meeting)
      else if (meeting.awaiting.size === 0) { this.finishRound(meeting); return [host.tabId, ...meeting.participants.keys()] }
      else meeting.cancelTimer = this.timers.set(() => this.timeOut(meeting), this.settings().roundTimeoutMinutes * 60_000)
    }
    this.changed(meeting)
    return [host.tabId, ...meeting.participants.keys()]
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

  /** Every message goes through here, so what a session has not finished answering is known (and saved). */
  private send(meeting: Meeting, tabId: string, kind: MeetingDeliveryKind, text: string, round = meeting.round): void {
    const delivery: MeetingDelivery = { meetingId: meeting.id, round, kind, text }
    if (kind !== 'add-dir') meeting.outstanding.set(tabId, delivery)
    this.effects.deliver(tabId, delivery)
  }

  private cancel(meeting: Meeting, tabId: string): void {
    meeting.outstanding.delete(tabId)
    this.effects.cancel(meeting.id, tabId)
  }

  /** The renderer is told, and the meeting is saved, after every change. */
  private changed(meeting: Meeting): void {
    this.effects.write(meeting.id, join(meeting.folder, MEETING_STATE_FILE), JSON.stringify(this.snapshot(meeting)))
    this.effects.changed()
  }

  private snapshot(meeting: Meeting): SavedMeeting {
    const saved = (party: Party): SavedParty => ({ sessionId: this.effects.sessionIdOf(party.tabId), title: party.title, folder: party.folder, role: party.role ?? null, counted: party.counted })
    return {
      version: 1,
      id: meeting.id,
      topic: meeting.topic,
      host: saved(meeting.host),
      participants: [...meeting.participants.values()].map((participant) => ({
        ...saved(participant), joinedRound: participant.joinedRound, missed: participant.missed,
        reply: meeting.replies.get(participant.tabId) ?? null, awaited: meeting.awaiting.has(participant.tabId),
      })),
      stage: meeting.stage,
      round: meeting.round,
      maxRounds: meeting.maxRounds,
      vote: meeting.vote,
      post: meeting.post,
      hasChanges: meeting.hasChanges,
      late: meeting.late,
      discussing: meeting.discussing,
      reviewed: meeting.reviewed,
      held: meeting.held,
      pauseReason: meeting.pauseReason,
      remindedHost: meeting.remindedHost,
      outcome: meeting.outcome,
      cost: meeting.cost,
      outstanding: [...meeting.outstanding].flatMap(([tabId, delivery]) => {
        const sessionId = this.effects.sessionIdOf(tabId)
        return sessionId ? [{ sessionId, delivery }] : []
      }),
    }
  }

  private removeParticipant(meeting: Meeting, participant: Participant, heading: string): void {
    const tabId = participant.tabId
    meeting.participants.delete(tabId)
    meeting.replies.delete(tabId)
    this.cancel(meeting, tabId)
    this.appendTranscript(meeting, heading, `In round ${meeting.round}.`)
    const wasAwaited = meeting.awaiting.delete(tabId)
    if (meeting.participants.size === 0 && meeting.stage === 'reviewing') {
      this.backToWaiting(meeting)
    } else if (wasAwaited && meeting.awaiting.size === 0 && meeting.stage === 'reviewing') {
      this.finishRound(meeting)
      return
    }
    this.changed(meeting)
  }

  private nextRound(meeting: Meeting, kind: 'round' | 'propose-close', post: string, changes: string | null): void {
    meeting.round++
    meeting.vote = kind === 'propose-close'
    meeting.post = post
    meeting.remindedHost = false
    this.writePost(meeting, meeting.vote ? `Round ${meeting.round}: the host proposes to close` : `Round ${meeting.round}: host`, meeting.vote ? null : changes)
    this.openRound(meeting)
    this.changed(meeting)
  }

  /**
   * Nobody is left to answer the round: it starts over for whoever joins next. A discussion in progress is abandoned with
   * it; otherwise the next review would be taken for a discussion answer, and the old reviews would reach the host with it.
   */
  private backToWaiting(meeting: Meeting): void {
    meeting.cancelTimer?.()
    meeting.cancelTimer = null
    meeting.replies.clear()
    meeting.discussing = false
    meeting.reviewed = null
    meeting.stage = 'waiting'
  }

  private openRound(meeting: Meeting): void {
    meeting.stage = 'reviewing'
    meeting.discussing = false
    meeting.reviewed = null
    meeting.replies.clear()
    meeting.awaiting = new Set(meeting.participants.keys())
    meeting.cancelTimer?.()
    meeting.cancelTimer = this.timers.set(() => this.timeOut(meeting), this.settings().roundTimeoutMinutes * 60_000)
    for (const tabId of meeting.participants.keys()) this.deliverRound(meeting, tabId, false)
  }

  private deliverRound(meeting: Meeting, tabId: string, joinedLate: boolean): void {
    const host = meeting.host
    const role = meeting.participants.get(tabId)?.role ?? null
    const text = meeting.vote
      ? voteMessage({ id: meeting.id, round: meeting.round, host, summary: meeting.post, folder: meeting.folder, joinedLate, role })
      : postMessage({ id: meeting.id, round: meeting.round, topic: meeting.topic, host, post: meeting.post, folder: meeting.folder, hasChanges: meeting.hasChanges, previousReplies: meeting.round > 1, joinedLate, role })
    this.send(meeting, tabId, meeting.vote ? 'vote' : 'post', text)
  }

  private timeOut(meeting: Meeting): void {
    meeting.cancelTimer = null
    if (meeting.stage !== 'reviewing') return
    for (const tabId of meeting.awaiting) this.cancel(meeting, tabId)
    // Those that may be taken out for silence count the round they let pass; the round ends as usual first.
    const silent = [...meeting.awaiting].flatMap((tabId) => {
      const participant = meeting.participants.get(tabId)
      if (!participant || this.effects.dropsWhenSilent?.(tabId) !== true) return []
      participant.missed++
      return participant.missed >= MAX_SILENT_ROUNDS ? [participant] : []
    })
    this.finishRound(meeting)
    for (const participant of silent) {
      if (!this.isOpen(meeting.id) || !meeting.participants.has(participant.tabId)) continue
      this.removeParticipant(meeting, participant, `Session ${partyLabel(participant)} was taken out: no reply in ${MAX_SILENT_ROUNDS} rounds in a row`)
      this.effects.dropped?.(participant.tabId, `You were taken out of meeting ${meeting.id}: no reply in ${MAX_SILENT_ROUNDS} rounds in a row.`)
    }
  }

  /** Everything collected is in (or the round timed out): on to the discussion, the host, or the close. */
  private finishRound(meeting: Meeting): void {
    meeting.cancelTimer?.()
    meeting.cancelTimer = null
    const view = (participant: Participant): MeetingReplyView => {
      const reply = meeting.replies.get(participant.tabId)
      return { title: participant.title, folder: participant.folder, role: participant.role ?? null, text: reply?.text ?? null, vote: reply?.vote ?? null }
    }
    const collected = [...meeting.participants.values()].map(view)
    meeting.awaiting.clear()
    const paths = roundPaths(meeting.folder, meeting.round)
    if (meeting.discussing) {
      const reviewed = meeting.reviewed ?? []
      const late = meeting.late
      meeting.late = []
      meeting.discussing = false
      meeting.reviewed = null
      this.effects.write(meeting.id, paths.replies, repliesDocument(meeting.id, meeting.round, reviewed, late, collected))
      this.toHost(meeting, reviewed, late, collected)
      return
    }
    // With two or more reviews, and the setting on, each reviewer first answers the others' reviews.
    const reviewers = [...meeting.participants.values()].filter((participant) => meeting.replies.get(participant.tabId)?.text)
    if (!meeting.vote && this.settings().discussion === true && reviewers.length >= 2) {
      this.effects.write(meeting.id, paths.replies, repliesDocument(meeting.id, meeting.round, collected, []))
      const reviewOf = new Map(reviewers.map((reviewer) => [reviewer.tabId, view(reviewer)]))
      meeting.discussing = true
      meeting.reviewed = collected
      meeting.replies = new Map()
      meeting.awaiting = new Set(reviewers.map((participant) => participant.tabId))
      meeting.cancelTimer = this.timers.set(() => this.timeOut(meeting), this.settings().roundTimeoutMinutes * 60_000)
      this.appendTranscript(meeting, `Round ${meeting.round}: discussion`, `${reviewers.length} reviewers answer each other.`)
      for (const reviewer of reviewers) {
        const others = reviewers.filter((other) => other.tabId !== reviewer.tabId).map((other) => reviewOf.get(other.tabId)!)
        this.send(meeting, reviewer.tabId, 'discussion', discussionMessage({ id: meeting.id, round: meeting.round, others, folder: meeting.folder, role: reviewer.role ?? null }))
      }
      this.changed(meeting)
      return
    }
    const late = meeting.late
    meeting.late = []
    this.effects.write(meeting.id, paths.replies, repliesDocument(meeting.id, meeting.round, collected, late))
    if (meeting.vote && collected.length > 0 && collected.every((reply) => reply.vote === 'agree')) {
      this.send(meeting, meeting.host.tabId, 'agreed', agreedMessage(meeting.id, meeting.round, collected.length, meeting.folder))
      this.close(meeting, 'agreed')
      return
    }
    this.toHost(meeting, collected, late, null)
  }

  private toHost(meeting: Meeting, replies: MeetingReplyView[], late: MeetingReplyView[], discussion: MeetingReplyView[] | null): void {
    meeting.stage = 'host'
    meeting.remindedHost = false
    this.send(meeting, meeting.host.tabId, 'digest', digestMessage({ id: meeting.id, round: meeting.round, vote: meeting.vote, folder: meeting.folder, replies, late, discussion }))
    this.changed(meeting)
  }

  private hostSilent(meeting: Meeting): void {
    if (!meeting.remindedHost) {
      meeting.remindedHost = true
      this.send(meeting, meeting.host.tabId, 'reminder', reminderMessage(meeting.id))
      this.changed(meeting)
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
    this.changed(meeting)
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
    for (const tabId of meeting.participants.keys()) this.cancel(meeting, tabId)
    if (outcome !== 'agreed') this.cancel(meeting, meeting.host.tabId)
    meeting.outstanding.clear()
    const how: Record<MeetingOutcome, string> = {
      agreed: 'Everyone agreed; the meeting is closed.',
      ended: 'The host ended the meeting.',
      stopped: 'The person stopped the meeting.',
      'host-left': 'The host session closed.',
    }
    this.appendTranscript(meeting, 'Closed', how[outcome])
    this.effects.notify(meeting.id, `Meeting ${meeting.id}: ${how[outcome]}`)
    this.changed(meeting)
  }

  private writePost(meeting: Meeting, heading: string, changes: string | null): void {
    const paths = roundPaths(meeting.folder, meeting.round)
    meeting.hasChanges = changes !== null && changes.trim().length > 0
    this.effects.write(meeting.id, paths.post, meeting.post)
    if (meeting.hasChanges) this.effects.write(meeting.id, paths.changes, sharedChanges(changes!))
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

/**
 * A patch as it may be kept anywhere in the meeting folder, which every reviewer can read: secret files withheld and
 * credentials masked first, then cut to size, so a secret file's section is withheld whole, never cut in the middle.
 * Filtering an already filtered patch changes nothing.
 */
function sharedChanges(changes: string): string {
  return bound(shareablePatch(changes), MAX_MEETING_PATCH_CHARS, '\n# The patch stops here: it exceeded the meeting limit.\n')
}

function bound(text: string, limit: number, note = ''): string {
  return text.length <= limit ? text : text.slice(0, limit) + note
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, limit: number): string | null => typeof value === 'string' ? value.slice(0, limit) : null
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
const usageOf = (value: unknown): MeetingUsage => isRecord(value) ? { nanoAiu: count(value.nanoAiu), premiumRequests: count(value.premiumRequests) } : { ...NO_USAGE }
/** A Copilot session id, or an outside agent's seat id (meeting-guests.ts), which is what a saved meeting remembers it by. */
const sessionIdOf = (value: unknown): string | null => typeof value === 'string' && /^(?:[0-9a-f-]{36}|guest:[0-9a-f]{16})$/i.test(value) ? value : null
const roundOf = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1000 ? value : null

function partyOf(value: unknown): SavedParty | null {
  if (!isRecord(value)) return null
  return {
    sessionId: sessionIdOf(value.sessionId),
    title: text(value.title, 200) ?? 'A session',
    folder: text(value.folder, 4096),
    role: typeof value.role === 'string' ? cleanRole(value.role) || null : null,
    counted: usageOf(value.counted),
  }
}

/** Replies as the host reads them (a label and the text), saved for late replies and a round under discussion. */
function replyViewsOf(values: readonly unknown[]): MeetingReplyView[] {
  return values.slice(0, MAX_MEETING_PARTICIPANTS * 4).flatMap((entry) => {
    const party = partyOf(entry)
    if (!party || !isRecord(entry)) return []
    return [{ title: party.title, folder: party.folder, role: party.role, text: text(entry.text, MAX_MEETING_REPLY_CHARS), vote: entry.vote === 'agree' || entry.vote === 'object' ? entry.vote : null }]
  })
}

function replyOf(value: unknown): Reply | null {
  if (!isRecord(value)) return null
  return { text: text(value.text, MAX_MEETING_REPLY_CHARS), vote: value.vote === 'agree' || value.vote === 'object' ? value.vote : null }
}

function deliveryOf(value: unknown, meetingId: string): MeetingDelivery | null {
  if (!isRecord(value)) return null
  const round = roundOf(value.round)
  const kind = DELIVERY_KINDS.find((candidate) => candidate === value.kind)
  const body = text(value.text, MAX_MEETING_POST_CHARS + MAX_MEETING_REPLY_CHARS * MAX_MEETING_PARTICIPANTS)
  return round && kind && body !== null ? { meetingId, round, kind, text: body } : null
}

/** A saved meeting as written by `snapshot`; anything malformed is not restored. The file is the desktop's own, but on disk. */
function readSavedMeeting(value: unknown): SavedMeeting | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== 'string' || !MEETING_ID_PATTERN.test(value.id)) return null
  const id = value.id
  const stage = STAGES.find((candidate) => candidate === value.stage)
  const round = roundOf(value.round)
  const maxRounds = roundOf(value.maxRounds)
  const host = partyOf(value.host)
  const post = text(value.post, MAX_MEETING_POST_CHARS)
  if (!stage || !round || !maxRounds || !host || post === null || !Array.isArray(value.participants)) return null
  const participants = value.participants.slice(0, MAX_MEETING_PARTICIPANTS).flatMap((entry) => {
    const party = partyOf(entry)
    if (!party || !isRecord(entry)) return []
    const missed = typeof entry.missed === 'number' && Number.isInteger(entry.missed) && entry.missed >= 0 ? Math.min(entry.missed, MAX_SILENT_ROUNDS) : 0
    return [{ ...party, joinedRound: roundOf(entry.joinedRound) ?? 1, reply: replyOf(entry.reply), awaited: entry.awaited === true, missed }]
  })
  const held = isRecord(value.held) && (value.held.kind === 'round' || value.held.kind === 'propose-close') && typeof value.held.text === 'string'
    ? { kind: value.held.kind, text: value.held.text.slice(0, MAX_MEETING_POST_CHARS), changes: typeof value.held.changes === 'string' ? sharedChanges(value.held.changes) : null } as HeldPost
    : null
  const late = Array.isArray(value.late) ? replyViewsOf(value.late) : []
  const outstanding = Array.isArray(value.outstanding) ? value.outstanding.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const sessionId = sessionIdOf(entry.sessionId)
    const delivery = deliveryOf(entry.delivery, id)
    return sessionId && delivery ? [{ sessionId, delivery }] : []
  }) : []
  return {
    version: 1,
    id,
    topic: cleanTopic(text(value.topic, 1000) ?? ''),
    host,
    participants,
    stage,
    round,
    maxRounds,
    vote: value.vote === true,
    post,
    hasChanges: value.hasChanges === true,
    late,
    // A discussion is only ever part of a review round being collected.
    discussing: value.discussing === true && stage === 'reviewing' && Array.isArray(value.reviewed),
    reviewed: value.discussing === true && Array.isArray(value.reviewed) ? replyViewsOf(value.reviewed) : null,
    held,
    pauseReason: value.pauseReason === 'round-limit' || value.pauseReason === 'host-silent' ? value.pauseReason : null,
    remindedHost: value.remindedHost === true,
    outcome: OUTCOMES.find((candidate) => candidate === value.outcome) ?? null,
    cost: usageOf(value.cost),
    outstanding,
  }
}

export function randomMeetingId(taken: (id: string) => boolean): string {
  for (;;) {
    let id = ''
    for (let index = 0; index < 4; index++) id += MEETING_ID_ALPHABET[randomInt(MEETING_ID_ALPHABET.length)]
    if (!taken(id)) return id
  }
}

const JOIN_REQUEST = /\bjoin\b[^\n]{0,40}?\b(?:meeting|chat)\b\s*(?:id\s*)?[#:]?\s*([a-z0-9]{4})\b([^\n]*)/i
const JOIN_ROLE = /^\s*,?\s*as\s+(?:an?\s+|the\s+)?(\S[^\n]*)$/i

/** The meeting id (and the role, "join meeting K7QF as security reviewer") in a message the person typed, or null. */
export function joinRequest(text: string): { id: string; role: string | null } | null {
  const match = JOIN_REQUEST.exec(text)
  const id = match?.[1]?.toUpperCase()
  if (!id || !MEETING_ID_PATTERN.test(id)) return null
  const role = JOIN_ROLE.exec(match![2] ?? '')?.[1]
  return { id, role: role ? cleanRole(role) || null : null }
}
