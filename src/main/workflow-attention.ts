import type { DesktopSessionTab } from './types.js'
import type { MeetingView } from './meeting.js'
import { redactDiagnosticText } from './desktop-diagnostics.js'
import type { WorkflowTask } from './workflow-types.js'

export type AttentionReason = 'Session stopped unexpectedly' | 'Needs approval' | 'Review meeting paused' | 'Task needs input' | 'Ready for review' | 'Task blocked or failed'
export interface AttentionItem { tabId: string; title: string; reasons: AttentionReason[]; key: string }
export function attentionTitle(value: string): string {
  return redactDiagnosticText(value).replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 120).trim() || 'Copilot session'
}
/** Activity is not an outcome: idle/completed/dormant processes never imply a reviewable result. */
export function workflowAttention(tabs: readonly DesktopSessionTab[], meetings: readonly MeetingView[], tasks: readonly WorkflowTask[] = []): AttentionItem[] {
  const result: AttentionItem[] = []
  for (const tab of tabs) {
    const reasons: AttentionReason[] = []
    if (tab.status === 'crashed') reasons.push('Session stopped unexpectedly')
    if (tab.status === 'approval-needed') reasons.push('Needs approval')
    const paused = meetings.filter(m => m.hostTabId === tab.id && m.stage === 'paused')
    if (paused.length) reasons.push('Review meeting paused')
    const task = tasks.find(t => t.sessionId === tab.lastSessionId && t.outcome !== 'completed' && t.outcome !== 'cancelled')
    if (task?.outcome === 'ready') reasons.push('Ready for review')
    if (task?.outcome === 'needs-input') reasons.push('Task needs input')
    if (task?.outcome === 'blocked' || task?.outcome === 'failed') reasons.push('Task blocked or failed')
    if (reasons.length) result.push({ tabId: tab.id, title: attentionTitle(tab.title), reasons,
      key: JSON.stringify([tab.id, tab.lastSessionId, tab.status, paused.map(m => [m.id, m.round, m.pauseReason]), task?.updatedAt]) })
  }
  const rank = (item: AttentionItem): number => item.reasons.includes('Session stopped unexpectedly') ? 0 : item.reasons.includes('Needs approval') ? 1 : 2
  return result.sort((a, b) => rank(a) - rank(b))
}
