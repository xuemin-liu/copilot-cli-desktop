import { randomUUID } from 'node:crypto'
import type { MeetingDelivery } from './meeting.js'
import type { WorkflowDeliveries,WorkflowDelivery } from './workflow-deliveries.js'

/** Maps the meeting's persisted message identity to the shared destination arbiter. */
export function journalMeetingDelivery(journal:WorkflowDeliveries,sessionId:string,delivery:MeetingDelivery):WorkflowDelivery|null {
  if(delivery.kind==='add-dir')throw new Error('Folder commands are idempotent meeting setup, not worker turns')
  delivery.id??=randomUUID()
  const source=`meeting/${delivery.meetingId}/${delivery.id}`,scope=`meeting/${delivery.meetingId}`
  const existing=journal.list().find(d=>d.sessionId===sessionId&&d.source===source&&d.scope===scope&&d.revision==='v1')
  if(!existing&&delivery.recovered&&journal.list().some(d=>d.sessionId===sessionId&&['submitting','submitted','uncertain'].includes(d.state)))return null
  const item=existing??journal.enqueue({sessionId,source,scope,revision:'v1',text:delivery.text})
  if(!existing&&delivery.recovered){
    // An old meeting file cannot prove whether its outstanding prompt was already typed.
    if(journal.begin(item.id,()=>true))journal.uncertain(item.id)
    else throw new Error('A recovered meeting needs reconciliation before more input')
  }
  return journal.get(item.id)!
}
