import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MeetingView } from './meeting.js'
import type { DesktopSessionTab } from './types.js'
import { MeetingBar, formatMeetingCost } from '../renderer/components/MeetingBar.js'

function tab(id: string, title: string, extra: Partial<DesktopSessionTab> = {}): DesktopSessionTab {
  return {
    id, title, workspaceProfileId: 'p', lastSessionId: null, status: 'running', activity: 'idle', processId: 1, cliVersion: '1.0.103',
    sessionPermissionPreset: 'read-only', sessionPermissionMode: null, permissionWarning: null, remote: false, lastActivityAt: 0, ...extra,
  }
}

const meeting: MeetingView = {
  id: 'K7QF', hostTabId: 'tab-host', hostTitle: 'host', topic: 'plan', stage: 'reviewing', round: 1, maxRounds: 6, vote: false, discussing: false,
  participants: [{ tabId: 'tab-b', title: 'reviewer', role: 'security reviewer', replied: false }], waitingFor: ['tab-b'], pauseReason: null, outcome: null, folder: 'C:\\m\\K7QF',
  cost: { aiCredits: 1.2345, premiumRequests: 0 },
}

test('Add session lists only sessions whose CLI is running and that are in no meeting', () => {
  const tabs = [
    tab('tab-host', 'host'), tab('tab-b', 'reviewer'),
    tab('tab-ready', 'ready reviewer'),
    tab('tab-approval', 'waiting for approval', { status: 'approval-needed' }),
    tab('tab-unloaded', 'unloaded session', { status: 'dormant', unloaded: true, processId: null }),
    tab('tab-dormant', 'restored, not started', { status: 'dormant', processId: null }),
    tab('tab-stopped', 'stopped session', { status: 'completed', processId: null }),
    tab('tab-remote', 'remote session', { remote: true }),
  ]
  const html = renderToStaticMarkup(<MeetingBar meetings={[meeting]} tabs={tabs} activeTabId="tab-host" onError={() => undefined} />)
  const options = [...html.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((match) => match[1])
  assert.deepEqual(options, ['tab-ready', 'tab-approval'], 'the "Add session…" placeholder is rendered as selected and not counted')
  assert.match(html, /Host · round 1 of 6 · Reviewing · waiting for reviewer · reviewers: reviewer \(security reviewer\) · 1\.23 AI credits used/)
  assert.match(html, /placeholder="Role \(optional\)"/)
})

test('outside agents are listed with Remove, a quiet one says since when, and invitations not yet used can be cancelled', () => {
  const now = Date.UTC(2026, 9, 28, 12, 0)
  const withGuests: MeetingView = {
    ...meeting,
    participants: [
      ...meeting.participants,
      { tabId: 'guest:0123456789abcdef', title: 'Claude Code (guest)', role: 'performance', replied: false, guest: { lastSeenAt: now - 30_000 } },
      { tabId: 'guest:fedcba9876543210', title: 'Codex (guest)', role: null, replied: false, guest: { lastSeenAt: now - 10 * 60_000 } },
    ],
    waitingFor: ['tab-b', 'guest:0123456789abcdef'],
    invited: [{ id: 'guest:1111111111111111', name: 'Gemini', role: 'security' }],
  }
  const html = renderToStaticMarkup(<MeetingBar meetings={[withGuests]} tabs={[tab('tab-host', 'host'), tab('tab-b', 'reviewer')]} activeTabId="tab-host" onError={() => undefined} now={now} />)
  assert.match(html, /waiting for reviewer, Claude Code \(guest\) · reviewers: reviewer \(security reviewer\), Claude Code \(guest\) \(performance\), Codex \(guest\)/, 'a guest is named by its seat, not as a closed session')
  assert.match(html, /AI credits used \(Copilot sessions only\)/)
  assert.match(html, /<li>Claude Code \(guest\) \(performance\)<button[^>]*>Remove<\/button><\/li>/, 'a guest that polls is not flagged')
  assert.match(html, /<li>Codex \(guest\)<span class="meeting-bar-quiet"> · not polling since [^<]+<\/span><button[^>]*>Remove<\/button><\/li>/)
  assert.match(html, /Gemini \(security\) · invited, not connected yet<button[^>]*>Cancel<\/button>/)
  assert.match(html, />Invite outside agent…<\/button>/)
})

test('the meeting cost reads as AI credits, with premium requests only when there are any', () => {
  assert.equal(formatMeetingCost({ aiCredits: 0, premiumRequests: 0 }), '0.00 AI credits used')
  assert.equal(formatMeetingCost({ aiCredits: 0.004, premiumRequests: 0 }), '<0.01 AI credits used')
  assert.equal(formatMeetingCost({ aiCredits: 12.345, premiumRequests: 1 }), '12.35 AI credits used · 1 premium request')
  assert.equal(formatMeetingCost({ aiCredits: 2, premiumRequests: 3 }), '2.00 AI credits used · 3 premium requests')
})

test('a meeting an outside agent hosts shows above any tab until a Copilot session joins it', () => {
  const hosted: MeetingView = {
    ...meeting, hostTabId: 'guest:0123456789abcdef', hostTitle: 'Claude Code (guest)', stage: 'waiting', participants: [], waitingFor: [],
  }
  const html = renderToStaticMarkup(<MeetingBar meetings={[hosted]} tabs={[tab('tab-a', 'some session')]} activeTabId="tab-a" onError={() => undefined} />)
  assert.match(html, /Hosted by Claude Code \(guest\) · round 1 of 6 · Waiting for someone to join/)
  assert.match(html, /<option value="tab-a">some session<\/option>/, 'the person adds Copilot sessions from it')
  const joined: MeetingView = { ...hosted, participants: [{ tabId: 'tab-b', title: 'reviewer', role: null, replied: false }] }
  const elsewhere = renderToStaticMarkup(<MeetingBar meetings={[joined]} tabs={[tab('tab-a', 'some session'), tab('tab-b', 'reviewer')]} activeTabId="tab-a" onError={() => undefined} />)
  assert.equal(elsewhere, '', 'once a session is in it, it shows above that session only')
})
