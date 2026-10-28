import { useState } from 'react'
import type { JSX } from 'react'
import type { MeetingView } from '../../main/meeting.js'
import type { DesktopSessionTab } from '../../main/types.js'

export interface MeetingBarProps {
  meetings: readonly MeetingView[]
  tabs: readonly DesktopSessionTab[]
  activeTabId: string | null
  onError(message: string): void
  /** Now, for how long ago a guest last asked for a message; a prop so tests can fix it. */
  now?: number
}

const OUTCOME: Record<NonNullable<MeetingView['outcome']>, string> = {
  agreed: 'Closed: everyone agreed',
  ended: 'Closed by the host',
  stopped: 'Stopped',
  'host-left': 'Closed: the host session closed',
}

/** A guest polls about every 100 s; one quiet for longer than this has probably stopped. */
export const GUEST_QUIET_MS = 3 * 60_000

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

/**
 * What the meeting's sessions used since they joined: AI credits as the CLI counts them, and premium requests if any. An
 * outside agent's use is billed by its own provider and not known here.
 */
export function formatMeetingCost(cost: MeetingView['cost'], withGuests = false): string {
  const credits = cost.aiCredits > 0 && cost.aiCredits < 0.01 ? '<0.01' : cost.aiCredits.toFixed(2)
  const requests = cost.premiumRequests > 0 ? ` · ${cost.premiumRequests} premium request${cost.premiumRequests === 1 ? '' : 's'}` : ''
  return `${credits} AI credits used${requests}${withGuests ? ' (Copilot sessions only)' : ''}`
}

/**
 * The meetings the active session hosts or takes part in, with the person's controls: add a session, invite an outside
 * agent, remove a guest, open the transcript, let a paused meeting go on, stop it.
 */
export function MeetingBar({ meetings, tabs, activeTabId, onError, now = Date.now() }: MeetingBarProps): JSX.Element | null {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  // The role the next added session reviews as, per meeting; cleared once it is used.
  const [roles, setRoles] = useState<Readonly<Record<string, string>>>({})
  // The meeting whose invite form is open, what it holds, and what happened to the last invitation.
  const [inviting, setInviting] = useState<string | null>(null)
  const [guestName, setGuestName] = useState('Claude Code')
  const [guestRole, setGuestRole] = useState('')
  const [invited, setInvited] = useState<string | null>(null)
  if (!activeTabId) return null
  const shown = meetings.filter((meeting) => !dismissed.has(meeting.id)
    && (meeting.hostTabId === activeTabId || meeting.participants.some((participant) => participant.tabId === activeTabId)))
  if (!shown.length) return null
  const busy = new Set(meetings.filter((meeting) => meeting.stage !== 'closed')
    .flatMap((meeting) => [meeting.hostTabId, ...meeting.participants.map((participant) => participant.tabId)]))
  const act = (meeting: MeetingView, action: 'stop' | 'resume' | 'join' | 'remove' | 'transcript', tabId?: string, role?: string): void => {
    void window.copilotDesktop.meetingAction(meeting.id, action, tabId, role).catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
  }
  const invite = (meeting: MeetingView): void => {
    void window.copilotDesktop.meetingInvite(meeting.id, guestName.trim(), guestRole.trim() || undefined).then(() => {
      setInvited(meeting.id)
      setGuestRole('')
    }, (error: unknown) => onError(error instanceof Error ? error.message : String(error)))
  }
  return (
    <div className="meeting-bars">
      {shown.map((meeting) => {
        const open = meeting.stage !== 'closed'
        // A guest is not a tab: its name is the one the meeting knows it by.
        const titleOf = (tabId: string): string => tabs.find((tab) => tab.id === tabId)?.title
          ?? meeting.participants.find((participant) => participant.tabId === tabId)?.title ?? 'a closed session'
        const named = (participant: MeetingView['participants'][number]): string => `${titleOf(participant.tabId)}${participant.role ? ` (${participant.role})` : ''}`
        const guests = meeting.participants.filter((participant) => participant.guest)
        const pending = meeting.invited ?? []
        // Only a session whose CLI is running can take the material; an unloaded or stopped one has to be resumed first.
        const candidates = tabs.filter((tab) => !tab.remote && !tab.unloaded && !busy.has(tab.id) && (tab.status === 'running' || tab.status === 'approval-needed'))
        const role = meeting.hostTabId === activeTabId ? 'Host' : 'Reviewer'
        return (
          <section key={meeting.id} className={`meeting-bar meeting-bar-${meeting.stage}`} aria-label={`Meeting ${meeting.id}`}>
            <span className="meeting-bar-id">Meeting {meeting.id}</span>
            <span className="meeting-bar-detail">
              {role} · round {meeting.round} of {meeting.maxRounds} · {meetingStageLabel(meeting, titleOf)}
              {meeting.participants.length > 0 && ` · reviewers: ${meeting.participants.map(named).join(', ')}`}
              {` · ${formatMeetingCost(meeting.cost, guests.length > 0)}`}
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
            {open && (
              <button type="button" className="meeting-bar-button" aria-expanded={inviting === meeting.id}
                onClick={() => { setInviting(inviting === meeting.id ? null : meeting.id); setInvited(null) }}>Invite outside agent…</button>
            )}
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
            {open && (guests.length > 0 || pending.length > 0) && (
              <ul className="meeting-bar-guests" aria-label={`Outside agents in meeting ${meeting.id}`}>
                {guests.map((guest) => {
                  const lastSeenAt = guest.guest?.lastSeenAt ?? null
                  const quiet = lastSeenAt !== null && now - lastSeenAt > GUEST_QUIET_MS
                  return (
                    <li key={guest.tabId}>
                      {named(guest)}
                      {quiet && <span className="meeting-bar-quiet"> · not polling since {new Date(lastSeenAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
                      <button type="button" className="meeting-bar-button" onClick={() => act(meeting, 'remove', guest.tabId)}>Remove</button>
                    </li>
                  )
                })}
                {pending.map((guest) => (
                  <li key={guest.id}>
                    {guest.name}{guest.role ? ` (${guest.role})` : ''} · invited, not connected yet
                    <button type="button" className="meeting-bar-button" onClick={() => act(meeting, 'remove', guest.id)}>Cancel</button>
                  </li>
                ))}
              </ul>
            )}
            {open && inviting === meeting.id && (
              <div className="meeting-bar-invite">
                <input className="meeting-bar-role" type="text" maxLength={40} placeholder="Agent name"
                  aria-label={`Name of the outside agent invited to meeting ${meeting.id}`} value={guestName} onChange={(event) => setGuestName(event.target.value)} />
                <input className="meeting-bar-role" type="text" maxLength={60} placeholder="Role (optional)"
                  aria-label={`Role of the outside agent invited to meeting ${meeting.id}`} value={guestRole} onChange={(event) => setGuestRole(event.target.value)} />
                <button type="button" className="meeting-bar-button" onClick={() => invite(meeting)}>Copy invitation</button>
                <span className="meeting-bar-note">
                  {invited === meeting.id
                    ? 'Invitation copied. Paste it into the agent on this computer; unused, it expires in 15 minutes.'
                    : 'The agent\'s own model provider sees the plan, the patch and the other reviews. Run it in a mode that asks before editing files.'}
                </span>
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
