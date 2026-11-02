import type { DesktopSessionTab } from './types.js'
import type { MeetingView } from './meeting.js'
import { redactDiagnosticText } from './desktop-diagnostics.js'
import type { WorkflowTask } from './workflow-types.js'
import type { FollowupGrant } from './workflow-followups.js'
import type { WorkflowDelivery } from './workflow-deliveries.js'

export type AttentionReason = 'Session stopped unexpectedly' | 'Needs approval' | 'Review meeting paused' | 'Task needs input' | 'Ready for review' | 'Task blocked or failed' | 'Follow-ups need attention' | 'Handoff needs reconciliation' | 'Task resource unavailable' | 'Task outcome needs review'
export interface AttentionItem { tabId: string; sessionId?: string; subjectId?:string; evidence?:string[]; title: string; reasons: AttentionReason[]; key: string }
export function attentionTitle(value: string): string {
  return redactDiagnosticText(value.replace(/[\p{Cc}\p{Cf}]/gu, '')).slice(0, 120).trim() || 'Copilot session'
}
function evidence(subject:string,reasons:readonly AttentionReason[],task:WorkflowTask|undefined,paused:readonly MeetingView[],grant:FollowupGrant|undefined,uncertain:readonly WorkflowDelivery[]):string[]{
  return reasons.map(reason=>JSON.stringify([subject,reason,
    ['Ready for review','Task needs input','Task blocked or failed','Task outcome needs review'].includes(reason)?[task?.id,task?.outcome,task?.reports?.at(-1)?.reportedAt??task?.createdAt??task?.updatedAt]
      :reason==='Review meeting paused'?paused.map(meeting=>[meeting.id,meeting.round,meeting.pauseReason])
      :reason==='Follow-ups need attention'?[grant?.id,grant?.health]
      :reason==='Handoff needs reconciliation'?uncertain.map(delivery=>delivery.id).sort()
      :reason==='Task resource unavailable'?task?.id:null]))
}
/** Activity is not an outcome: idle/completed/dormant processes never imply a reviewable result. */
export function workflowAttention(tabs: readonly DesktopSessionTab[], meetings: readonly MeetingView[], tasks: readonly WorkflowTask[] = [],grants:readonly FollowupGrant[]=[],deliveries:readonly WorkflowDelivery[]=[]): AttentionItem[] {
  const result: AttentionItem[] = []
  for (const tab of tabs) {
    const reasons: AttentionReason[] = []
    if (tab.status === 'crashed') reasons.push('Session stopped unexpectedly')
    if (tab.status === 'approval-needed') reasons.push('Needs approval')
    const paused = meetings.filter(m => m.hostTabId === tab.id && m.stage === 'paused')
    if (paused.length) reasons.push('Review meeting paused')
    const task = tasks.find(t => t.sessionId === tab.lastSessionId && t.outcome !== 'completed' && t.outcome !== 'cancelled')
    if(task?.origin==='automation'&&task.outcome==='unknown'&&!task.awaitingSubmission)reasons.push('Task outcome needs review')
    if(task?.resources?.worktree==='missing')reasons.push('Task resource unavailable')
    if (task?.outcome === 'ready') reasons.push('Ready for review')
    if (task?.outcome === 'needs-input') reasons.push('Task needs input')
    if (task?.outcome === 'blocked' || task?.outcome === 'failed') reasons.push('Task blocked or failed')
    const grant=grants.find(g=>g.sessionId===tab.lastSessionId&&g.health!=='watching'&&g.health!=='paused'&&g.health!=='closed')
    if(grant)reasons.push('Follow-ups need attention')
    const uncertain=deliveries.filter(d=>d.sessionId===tab.lastSessionId&&d.state==='uncertain')
    if(uncertain.length)reasons.push('Handoff needs reconciliation')
    if(reasons.length){const subject=tab.lastSessionId??tab.id,facts=evidence(subject,reasons,task,paused,grant,uncertain)
      result.push({tabId:tab.id,subjectId:subject,title:attentionTitle(tab.title),reasons,evidence:facts,key:JSON.stringify(facts)})}

  }
  const represented=new Set(tabs.map(tab=>tab.lastSessionId))
  const closedTasks=[...tasks].sort((a,b)=>Number(['completed','cancelled'].includes(a.outcome))-Number(['completed','cancelled'].includes(b.outcome))||b.updatedAt-a.updatedAt)
  for(const task of closedTasks){
    if(represented.has(task.sessionId))continue
    represented.add(task.sessionId)
    const reasons:AttentionReason[]=[]
    if(!['completed','cancelled'].includes(task.outcome)&&task.resources?.worktree==='missing')reasons.push('Task resource unavailable')
    if(task.origin==='automation'&&task.outcome==='unknown'&&!task.awaitingSubmission)reasons.push('Task outcome needs review')
    if(task.outcome==='needs-input')reasons.push('Task needs input')
    if(task.outcome==='blocked'||task.outcome==='failed')reasons.push('Task blocked or failed')
    if(task.outcome==='ready')reasons.push('Ready for review')
    const grant=grants.find(grant=>grant.taskId===task.id&&grant.enabled&&!['watching','paused','closed'].includes(grant.health))
    if(grant)reasons.push('Follow-ups need attention')
    const uncertain=deliveries.filter(delivery=>delivery.sessionId===task.sessionId&&delivery.state==='uncertain')
    if(uncertain.length)reasons.push('Handoff needs reconciliation')
    if(reasons.length){const facts=evidence(task.sessionId,reasons,task,[],grant,uncertain)
      result.push({tabId:`task:${task.id}`,sessionId:task.sessionId,subjectId:task.sessionId,title:attentionTitle(task.title),reasons,evidence:facts,key:JSON.stringify(facts)})}

  }
  for(const delivery of deliveries){
    if(delivery.state!=='uncertain'||represented.has(delivery.sessionId))continue
    represented.add(delivery.sessionId)
    const uncertain=deliveries.filter(candidate=>candidate.sessionId===delivery.sessionId&&candidate.state==='uncertain')
    const reasons:AttentionReason[]=['Handoff needs reconciliation'],facts=evidence(delivery.sessionId,reasons,undefined,[],undefined,uncertain)
    result.push({tabId:`handoff:${delivery.sessionId}`,sessionId:delivery.sessionId,subjectId:delivery.sessionId,title:'Workflow handoff',reasons,evidence:facts,key:JSON.stringify(facts)})
  }
  const rank = (item: AttentionItem): number => item.reasons.includes('Session stopped unexpectedly') ? 0 : item.reasons.includes('Needs approval') ? 1
    : item.reasons.some(reason=>reason==='Task blocked or failed'||reason==='Handoff needs reconciliation'||reason==='Follow-ups need attention'||reason==='Task resource unavailable')?2
    : item.reasons.some(reason=>reason==='Task needs input'||reason==='Review meeting paused'||reason==='Task outcome needs review')?3:4
  return result.sort((a, b) => rank(a) - rank(b))
}
