import { randomUUID } from 'node:crypto'
import type { MeetingDelivery, MeetingDeliveryKind, MeetingStage } from './meeting.js'
import type { WorkflowDeliveries,WorkflowDelivery } from './workflow-deliveries.js'

/**
 * A closed meeting can take no more replies, so nothing in its scope can be sent again or matter to anyone. What was left
 * uncertain (the app restarted during a turn, say) must not go on blocking that session from every later meeting.
 */
export function settleClosedMeeting(journal:WorkflowDeliveries,scope:string):void {
  for(const delivery of journal.list())if(delivery.scope===scope&&delivery.state==='uncertain')journal.discard(delivery.id)
  journal.retireScope(scope)
}

/**
 * The host answered its round (for instance after reading replies directly), so any queued or uncertain digest/reminder for
 * that host in this meeting is resolved and must not block later rounds or the closing vote.
 */
export function settleHostDelivery(
  journal: WorkflowDeliveries,
  scope: string,
  sessionId: string,
  ids?: ReadonlySet<string>,
): void {
  for (const delivery of journal.list()) {
    if (delivery.scope === scope && delivery.sessionId === sessionId
      && (ids === undefined || ids.has(delivery.id))
      && (delivery.state === 'queued' || delivery.state === 'uncertain')) {
      journal.discard(delivery.id)
    }
  }
}

/** Extracts the meeting id and delivery id from a meeting journal row; null for non-meeting handoffs. */
export function meetingDeliverySource(delivery: Pick<WorkflowDelivery, 'scope' | 'source'>): { meetingId: string; deliveryId: string } | null {
  if (!delivery.scope.startsWith('meeting/')) return null
  const meetingId = delivery.scope.slice('meeting/'.length)
  const prefix = `meeting/${meetingId}/`
  if (!meetingId || !delivery.source.startsWith(prefix)) return null
  const deliveryId = delivery.source.slice(prefix.length)
  return deliveryId ? { meetingId, deliveryId } : null
}

const MEETING_DELIVERY_TEXT = /^Meeting ([A-Za-z0-9-]+), round (\d+), (post|vote|discussion|digest|agreed|reminder)\. Original material remains in the meeting snapshot\.$/

/** Extracts meeting identity, round and delivery kind from a meeting journal row's host-authored audit text. */
export function meetingDeliveryInfo(
  delivery: Pick<WorkflowDelivery, 'scope' | 'source' | 'text'>,
): { meetingId: string; deliveryId: string; round: number; kind: MeetingDeliveryKind } | null {
  const ref = meetingDeliverySource(delivery)
  if (!ref) return null
  const match = MEETING_DELIVERY_TEXT.exec(delivery.text)
  if (!match || match[1] !== ref.meetingId) return null
  const round = Number(match[2])
  if (!Number.isInteger(round) || round < 1) return null
  return { ...ref, round, kind: match[3] as MeetingDeliveryKind }
}

/**
 * Retires only host digest/reminder journal rows that a restored meeting snapshot proves have already been superseded
 * (the crash window after the new round's `meeting.json` landed on disk and before the journal discarded the old digest).
 * Current-round digests, reviewer deliveries, `agreed` messages, and non-meeting rows are left untouched.
 */
export function settleSupersededHostDeliveries(
  journal: WorkflowDeliveries,
  meeting: {
    id: string
    hostSessionId: string
    round: number
    stage: MeetingStage
    pauseReason: 'round-limit' | 'host-silent' | null
    /** Delivery id still outstanding for the host in this restored meeting, if any. */
    outstandingHostDeliveryId?: string | null
  },
): void {
  const scope = `meeting/${meeting.id}`
  for (const delivery of journal.list()) {
    if (delivery.scope !== scope || delivery.sessionId !== meeting.hostSessionId) continue
    if (delivery.state !== 'queued' && delivery.state !== 'uncertain') continue
    const info = meetingDeliveryInfo(delivery)
    if (!info || (info.kind !== 'digest' && info.kind !== 'reminder')) continue
    if (meeting.outstandingHostDeliveryId && info.deliveryId === meeting.outstandingHostDeliveryId) continue
    const advanced = meeting.round > info.round
      || (meeting.round === info.round && meeting.stage === 'paused' && meeting.pauseReason === 'round-limit')
    if (advanced) journal.discard(delivery.id)
  }
}

/** Maps the meeting's persisted message identity to the shared destination arbiter. */
export function journalMeetingDelivery(journal:WorkflowDeliveries,sessionId:string,delivery:MeetingDelivery,changed?:()=>void):WorkflowDelivery|null {
  if(delivery.kind==='add-dir')throw new Error('Folder commands are idempotent meeting setup, not worker turns')
  delivery.id??=randomUUID()
  const source=`meeting/${delivery.meetingId}/${delivery.id}`,scope=`meeting/${delivery.meetingId}`
  const existing=journal.list().find(d=>d.sessionId===sessionId&&d.source===source&&d.scope===scope&&d.revision==='v1')
  if(!existing&&delivery.recovered&&journal.list().some(d=>d.sessionId===sessionId&&['submitting','submitted','uncertain'].includes(d.state)))return null
  // This is audit text, not the executable payload. The meeting snapshot owns the original review material.
  const item=existing??journal.enqueue({sessionId,source,scope,revision:'v1',text:`Meeting ${delivery.meetingId}, round ${delivery.round}, ${delivery.kind}. Original material remains in the meeting snapshot.`})
  if(!existing&&delivery.recovered){
    // An old meeting file cannot prove whether its outstanding prompt was already typed.
    if(journal.begin(item.id,()=>true))journal.uncertain(item.id)
    else throw new Error('A recovered meeting needs reconciliation before more input')
  }
  if(!existing)changed?.()
  return journal.get(item.id)!
}
