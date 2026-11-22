import { randomUUID } from 'node:crypto'
import type { MeetingDelivery } from './meeting.js'
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
