import { useState } from 'react'
import type { JSX } from 'react'
import type { MeetingView } from '../../main/meeting.js'
import type { DesktopSessionTab } from '../../main/types.js'

export interface MeetingBarProps {
  meetings: readonly MeetingView[]
  tabs: readonly DesktopSessionTab[]
  activeTabId: string | null
  onError(message: string): void
}

const OUTCOME: Record<NonNullable<MeetingView['outcome']>, string> = {
  agreed: 'Closed: everyone agreed',
  ended: 'Closed by the host',
  stopped: 'Stopped',
  'host-left': 'Closed: the host session closed',
}

/** Where the meeting stands, in a few words. */
export function meetingStageLabel(meeting: MeetingView, titleOf: (tabId: string) => string): string {
  switch (meeting.stage) {
    case 'waiting': return meeting.participants.length ? 'Waiting for the host' : 'Waiting for someone to join'
    case 'reviewing': {
      const waiting = meeting.waitingFor.map(titleOf)
      return `${meeting.discussing ? 'Reviewers answering each other' : meeting.vote ? 'Voting' : 'Reviewing'}${waiting.length ? ` · waiting for ${waiting.join(', ')}` : ''}`
    }
    case 'host': return 'The host is answering'
    case 'paused': return meeting.pauseReason === 'round-limit' ? `Paused at the ${meeting.maxRounds}-round limit` : 'Paused: the host did not answer'
    case 'closed': return meeting.outcome ? OUTCOME[meeting.outcome] : 'Closed'
  }
}

/** What the meeting's sessions used since they joined: AI credits as the CLI counts them, and premium requests if any. */
export function formatMeetingCost(cost: MeetingView['cost']): string {
  const credits = cost.aiCredits > 0 && cost.aiCredits < 0.01 ? '<0.01' : cost.aiCredits.toFixed(2)
  const requests = cost.premiumRequests > 0 ? ` · ${cost.premiumRequests} premium request${cost.premiumRequests === 1 ? '' : 's'}` : ''
  return `${credits} AI credits used${requests}`
}

/**
 * The meetings the active session hosts or takes part in, with the person's controls: add a session, open the transcript,
 * let a paused meeting go on, stop it.
 */
export function MeetingBar({ meetings, tabs, activeTabId, onError }: MeetingBarProps): JSX.Element | null {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  // The role the next added session reviews as, per meeting; cleared once it is used.
  const [roles, setRoles] = useState<Readonly<Record<string, string>>>({})
  if (!activeTabId) return null
  const shown = meetings.filter((meeting) => !dismissed.has(meeting.id)
    && (meeting.hostTabId === activeTabId || meeting.participants.some((participant) => participant.tabId === activeTabId)))
  if (!shown.length) return null
  const titleOf = (tabId: string): string => tabs.find((tab) => tab.id === tabId)?.title ?? 'a closed session'
  const busy = new Set(meetings.filter((meeting) => meeting.stage !== 'closed')
    .flatMap((meeting) => [meeting.hostTabId, ...meeting.participants.map((participant) => participant.tabId)]))
  const act = (meeting: MeetingView, action: 'stop' | 'resume' | 'join' | 'transcript', tabId?: string, role?: string): void => {
    void window.copilotDesktop.meetingAction(meeting.id, action, tabId, role).catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
  }
  const named = (participant: MeetingView['participants'][number]): string => `${titleOf(participant.tabId)}${participant.role ? ` (${participant.role})` : ''}`
  return (
    <div className="meeting-bars">
      {shown.map((meeting) => {
        const open = meeting.stage !== 'closed'
        // Only a session whose CLI is running can take the material; an unloaded or stopped one has to be resumed first.
        const candidates = tabs.filter((tab) => !tab.remote && !tab.unloaded && !busy.has(tab.id) && (tab.status === 'running' || tab.status === 'approval-needed'))
        const role = meeting.hostTabId === activeTabId ? 'Host' : 'Reviewer'
        return (
          <section key={meeting.id} className={`meeting-bar meeting-bar-${meeting.stage}`} aria-label={`Meeting ${meeting.id}`}>
            <span className="meeting-bar-id">Meeting {meeting.id}</span>
            <span className="meeting-bar-detail">
              {role} · round {meeting.round} of {meeting.maxRounds} · {meetingStageLabel(meeting, titleOf)}
              {meeting.participants.length > 0 && ` · reviewers: ${meeting.participants.map(named).join(', ')}`}
              {` · ${formatMeetingCost(meeting.cost)}`}
            </span>
            {open && candidates.length > 0 && (<>
              <input className="meeting-bar-role" type="text" maxLength={60} placeholder="Role (optional)"
                aria-label={`Role of the next session added to meeting ${meeting.id}`} value={roles[meeting.id] ?? ''}
                onChange={(event) => { const value = event.target.value; setRoles((previous) => ({ ...previous, [meeting.id]: value })) }} />
              <select className="meeting-bar-add" aria-label={`Add a session to meeting ${meeting.id}`} value=""
                onChange={(event) => {
                  if (!event.target.value) return
                  act(meeting, 'join', event.target.value, roles[meeting.id]?.trim() || undefined)
                  setRoles((previous) => ({ ...previous, [meeting.id]: '' }))
                }}>
                <option value="">Add session…</option>
                {candidates.map((tab) => <option key={tab.id} value={tab.id}>{tab.title}</option>)}
              </select>
            </>)}
            {meeting.stage === 'paused' && (
              <button type="button" className="meeting-bar-button" onClick={() => act(meeting, 'resume')}>
                {meeting.pauseReason === 'round-limit' ? 'Allow 3 more rounds' : 'Remind the host'}
              </button>
            )}
            <button type="button" className="meeting-bar-button" onClick={() => act(meeting, 'transcript')}>Transcript</button>
            {open
              ? <button type="button" className="meeting-bar-button meeting-bar-stop" onClick={() => act(meeting, 'stop')}>{meeting.stage === 'paused' ? 'End' : 'Stop'}</button>
              : <button type="button" className="icon-button" aria-label={`Dismiss meeting ${meeting.id}`}
                  onClick={() => setDismissed((previous) => new Set([...previous, meeting.id]))}>×</button>}
          </section>
        )
      })}
    </div>
  )
}
