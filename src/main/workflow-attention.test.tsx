import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { workflowAttention, attentionTitle } from './workflow-attention.js'
import type { DesktopSessionTab } from './types.js'
import type { MeetingView } from './meeting.js'
import { NeedsYou } from '../renderer/components/NeedsYou.js'
import type {WorkflowTask} from './workflow-types.js'

const tab: DesktopSessionTab = { id: 'a', title: 'Task', workspaceProfileId: 'other', lastSessionId: null,
  status: 'running', processId: 1, cliVersion: '1.0.105', sessionPermissionPreset: 'default', sessionPermissionMode: null,
  permissionWarning: null, remote: false, lastActivityAt: 1 }
test('closed tasks remain actionable and failures and questions sort ahead of review results',()=>{
  const task=(id:string,outcome:WorkflowTask['outcome']):WorkflowTask=>({id,sessionId:id,projectId:'other',title:`Task ${id}`,request:'',assignmentId:id,scopeRevision:1,outcome,summary:'',validation:[],updatedAt:1,createdAt:1})
  const tasks=[task('ready','ready'),task('question','needs-input'),task('failure','blocked')]
  const items=workflowAttention([],[],tasks)
  assert.deepEqual(items.map(item=>item.sessionId),['failure','question','ready'])
  assert.equal(items[0]?.tabId,'task:failure')
  const changed=workflowAttention([],[],tasks.map(task=>({...task,updatedAt:99,worktreePath:'/new-observation'})))
  assert.deepEqual(changed.map(item=>item.key),items.map(item=>item.key),'a resource refresh is not new outcome evidence')
  assert.equal(workflowAttention([{...tab,lastSessionId:'failure'}],[],tasks).filter(item=>item.reasons.includes('Task blocked or failed')).length,1)
})
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

  const mcpHostedPaused = { id: 'm2', hostTabId: 'guest:0123456789abcdef', hostDesktopTabId: 'a', stage: 'paused', round: 1, pauseReason: 'host-silent' } as MeetingView
  const mcpItems = workflowAttention([tab], [mcpHostedPaused])
  assert.equal(mcpItems.length, 1)
  assert.deepEqual(mcpItems[0]!.reasons, ['Review meeting paused'])
})
test('attention titles mask credentials and controls before presentation', () => {
  assert.equal(attentionTitle('to\u200bken=synthetic-private-value'), 'token=[REDACTED]')
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
test('an unsettled PR-loop post needs the person; an approved loop does not', () => {
  const grant = { id: 'g1', taskId: 't', sessionId: 's1', projectId: 'p', scopeRevision: 1, permissionKey: 'a'.repeat(64), repository: 'o/r', number: 1, reviewers: [], failedChecks: false,
    enabled: true, activatedAt: 0, seen: {}, head: 'a'.repeat(40), headCounts: {}, total: 0, health: 'watching' as const, checks: 'absent' as const, role: 'author' as const }
  const session = { ...tab, lastSessionId: 's1' }
  const post = (state: 'intent' | 'uncertain', createdAt: number) => ({ id: 'p1', grantId: 'g1', state, kind: 'reply' as const, target: 1, createdAt })
  const reasons = (posts: ReturnType<typeof post>[], g = grant) => workflowAttention([session], [], [], [g], [], posts, 10 * 60_000).flatMap((item) => item.reasons)
  assert.ok(reasons([post('uncertain', 9 * 60_000)]).includes('PR post needs checking'))
  assert.ok(reasons([post('intent', 0)]).includes('PR post needs checking'), 'an intent stuck for five minutes')
  assert.ok(!reasons([post('intent', 9 * 60_000)]).includes('PR post needs checking'), 'a write still in flight')
  assert.deepEqual(reasons([], { ...grant, enabled: false, health: 'approved' as never }), [], 'a confirmed approval leaves nothing to do')
})
