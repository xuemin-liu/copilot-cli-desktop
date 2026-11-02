import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { workflowAttention, attentionTitle } from './workflow-attention.js'
import type { DesktopSessionTab } from './types.js'
import type { MeetingView } from './meeting.js'
import { NeedsYou } from '../renderer/components/NeedsYou.js'

const tab: DesktopSessionTab = { id: 'a', title: 'Task', workspaceProfileId: 'other', lastSessionId: null,
  status: 'running', processId: 1, cliVersion: '1.0.105', sessionPermissionPreset: 'default', sessionPermissionMode: null,
  permissionWarning: null, remote: false, lastActivityAt: 1 }
test('attention spans projects, prioritizes failures, and never infers success from idle or exit', () => {
  const tabs = [tab, { ...tab, id: 'approval', status: 'approval-needed' as const },
    { ...tab, id: 'crash', status: 'crashed' as const }, { ...tab, id: 'done', status: 'completed' as const },
    { ...tab, id: 'sleep', status: 'dormant' as const }, { ...tab, id: 'idle', activity: 'idle' as const }]
  assert.deepEqual(workflowAttention(tabs, []).map(item => item.tabId), ['crash', 'approval'])
  assert.equal(workflowAttention([tab], []).length, 0)
})
test('paused meetings add one reason to their host and clear on resume', () => {
  const meeting = { id: 'm', hostTabId: 'a', stage: 'paused', round: 2, pauseReason: 'round-limit' } as MeetingView
  const items = workflowAttention([{ ...tab, status: 'approval-needed' }], [meeting, meeting])
  assert.equal(items.length, 1)
  assert.deepEqual(items[0]!.reasons, ['Needs approval', 'Review meeting paused'])
  assert.equal(workflowAttention([tab], [{ ...meeting, stage: 'reviewing' }]).length, 0)
  assert.notEqual(items[0]!.key, workflowAttention([{ ...tab, status: 'approval-needed' }], [{ ...meeting, round: 3 }])[0]!.key)
})
test('attention titles mask credentials and controls before presentation', () => {
  assert.equal(attentionTitle('token=fixture-secret\u202e\u0000'), 'token=[REDACTED]')
  assert.equal(attentionTitle(''), 'Copilot session')
  const items = workflowAttention([{ ...tab, title: 'token=fixture-secret', status: 'crashed' }], [])
  const markup = renderToStaticMarkup(<NeedsYou items={items} compact={false} onExpand={() => {}} onActivate={() => {}} />)
  assert.match(markup, /Needs you/)
  assert.match(markup, /Session stopped unexpectedly/)
  assert.doesNotMatch(markup, /fixture-secret/)
  assert.equal(renderToStaticMarkup(<NeedsYou items={[]} compact={false} onExpand={() => {}} onActivate={() => {}} />), '')
  assert.match(renderToStaticMarkup(<NeedsYou items={items} compact onExpand={() => {}} onActivate={() => {}} />), /aria-label="Needs you: 1"/)
})
