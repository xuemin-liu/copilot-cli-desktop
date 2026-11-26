import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReviewerBar } from '../renderer/components/ReviewerBar.js'
import { Sidebar } from '../renderer/components/Sidebar.js'
import { DEFAULT_SESSION_LAUNCH_CONFIG } from './session-launch.js'
import type { DesktopSessionTab, TempReviewerGroupView, WorkspaceProfile } from './types.js'

const PROFILE: WorkspaceProfile = {
  id: '0123456789abcdef',
  name: 'demo-repo',
  path: '/tmp/demo-repo',
  permissionPreset: 'default',
  defaultResumeMode: 'new',
  launch: { ...DEFAULT_SESSION_LAUNCH_CONFIG },
  tabs: [],
}

function makeTab(id: string, title: string, extra: Partial<DesktopSessionTab> = {}): DesktopSessionTab {
  return {
    id,
    title,
    workspaceProfileId: PROFILE.id,
    lastSessionId: '11111111-1111-4111-8111-111111111111',
    status: 'running',
    processId: 100,
    cliVersion: '1.0.114',
    sessionPermissionPreset: 'default',
    sessionPermissionMode: null,
    permissionWarning: null,
    remote: false,
    lastActivityAt: 1000,
    ...extra,
  }
}

test('ReviewerBar renders per-CLI chips, needs-approval indicator, and Peek/Hide/Retry/Dismiss/Stop controls', () => {
  const group: TempReviewerGroupView = {
    id: '22222222-2222-4222-8222-222222222222',
    hostTabId: 'tab-1',
    profileId: PROFILE.id,
    repository: 'omaha:3001/owner/repo',
    prLabel: 'PR #42',
    prNumber: 42,
    prUrl: 'http://omaha:3001/owner/repo/pulls/42',
    round: 2,
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    stage: 'active',
    outcome: null,
    seats: [
      {
        cli: 'copilot',
        tabId: 'tab-2',
        verdict: 'reviewing',
        checkedOut: 'a'.repeat(40),
        needsAttention: false,
        error: null,
        keptCheckoutPath: null,
      },
      {
        cli: 'claude',
        tabId: 'tab-3',
        verdict: 'reviewing',
        checkedOut: 'a'.repeat(40),
        needsAttention: true,
        error: null,
        keptCheckoutPath: null,
      },
      {
        cli: 'codex',
        tabId: null,
        verdict: 'failed',
        checkedOut: 'a'.repeat(40),
        needsAttention: true,
        error: 'Codex exited unexpectedly',
        keptCheckoutPath: null,
      },
      {
        cli: 'antigravity',
        tabId: 'tab-4',
        verdict: 'reviewing',
        checkedOut: 'a'.repeat(40),
        needsAttention: false,
        error: null,
        keptCheckoutPath: null,
      },
    ],
    notice: null,
  }

  const activeHtml = renderToStaticMarkup(
    <ReviewerBar groups={[group]} activeTabId="tab-1" peekTabId="tab-2" onPeek={() => {}} onError={() => {}} />,
  )
  assert.match(activeHtml, /PR #42/)
  assert.match(activeHtml, /Copilot CLI/)
  assert.match(activeHtml, /Claude Code/)
  assert.match(activeHtml, /Codex CLI/)
  assert.match(activeHtml, /Antigravity CLI/)
  assert.match(activeHtml, /reviewing on PR…/)
  assert.match(activeHtml, /needs approval/)
  assert.match(activeHtml, /Hide/)
  assert.match(activeHtml, /Peek/)
  assert.equal((activeHtml.match(/>Retry</g) ?? []).length, 4, 'Retry is available on reviewing, needsAttention, and failed seats')
  assert.equal((activeHtml.match(/>Dismiss</g) ?? []).length, 4, 'Dismiss is available on all active seats')
  assert.match(activeHtml, /Stop reviewers/)

  // Starting seats expose Dismiss (so a stuck launch can be dropped) without Retry:
  const startingGroup: TempReviewerGroupView = {
    ...group,
    stage: 'starting',
    seats: [{
      cli: 'copilot',
      tabId: null,
      verdict: 'starting',
      checkedOut: 'a'.repeat(40),
      needsAttention: false,
      error: null,
      keptCheckoutPath: null,
    }],
  }
  const startingHtml = renderToStaticMarkup(
    <ReviewerBar groups={[startingGroup]} activeTabId="tab-1" peekTabId={null} onPeek={() => {}} onError={() => {}} />,
  )
  assert.equal((startingHtml.match(/>Retry</g) ?? []).length, 0)
  assert.equal((startingHtml.match(/>Dismiss</g) ?? []).length, 1)

  // When focus moves into the peeked reviewer terminal (activeTabId === 'tab-2'), Hide and Peek remain available:
  const focusedOnReviewerHtml = renderToStaticMarkup(
    <ReviewerBar groups={[group]} activeTabId="tab-2" peekTabId="tab-2" onPeek={() => {}} onError={() => {}} />,
  )
  assert.match(focusedOnReviewerHtml, /Hide/)
  assert.match(focusedOnReviewerHtml, /Peek/)

  const unrelatedHtml = renderToStaticMarkup(
    <ReviewerBar groups={[group]} activeTabId="tab-99" peekTabId={null} onPeek={() => {}} onError={() => {}} />,
  )
  assert.equal(unrelatedHtml, '')

  // Profile-scoped groups render on activeProfileId and show final PR outcome:
  const endedGroup: TempReviewerGroupView = {
    ...group,
    hostTabId: null,
    prLabel: 'MR !7',
    prNumber: 7,
    prUrl: null,
    stage: 'ended',
    outcome: 'approved',
  }
  const endedHtml = renderToStaticMarkup(
    <ReviewerBar groups={[endedGroup]} activeTabId="tab-99" activeProfileId={PROFILE.id} peekTabId={null} onPeek={() => {}} onError={() => {}} />,
  )
  assert.match(endedHtml, /<span class="reviewer-bar-pr"[^>]*>MR !7<\/span>/)
  assert.match(endedHtml, /Approved on PR/)
})

test('Sidebar hides tempReviewer tabs from main session lists and tucks them into a Reviewers disclosure under the host tab', () => {
  const host = makeTab('tab-1', 'Fix PR #42')
  const hiddenReviewer = makeTab('tab-2', 'Review PR #42 · Claude Code', {
    cli: 'claude',
    tempReviewer: {
      groupId: '22222222-2222-4222-8222-222222222222',
      hostTabId: 'tab-1',
      cli: 'claude',
      prLabel: 'PR #42',
      prNumber: 42,
      repository: 'omaha:3001/owner/repo',
      prUrl: 'http://omaha:3001/owner/repo/pulls/42',
    },
  })
  const noop = (): void => {}
  const expandedHtml = renderToStaticMarkup(
    <Sidebar
      profiles={[PROFILE]}
      tabs={[host, hiddenReviewer]}
      installedCliVersion="1.0.114"
      activeProfileId={PROFILE.id}
      activeTabId="tab-1"
      canOpenTab
      collapsed={false}
      onToggleCollapsed={noop}
      onSelectWorkspace={noop}
      onActivateProfile={noop}
      onRemoveProfile={noop}
      onActivateTab={noop}
      onPopOutTab={noop}
      onRenameTab={noop}
      onCloseTab={noop}
      onRestartTab={noop}
      onUnloadTab={noop}
      onCreateTab={noop}
      onCreateTabWithAttachments={noop}
      onFanOut={noop}
      onResumePicker={noop}
      onOpenHistory={noop}
      onConnectRemote={noop}
      onOpenSettings={noop}
    />,
  )
  assert.match(expandedHtml, /Reviewers \(1\)/)

  const collapsedHtml = renderToStaticMarkup(
    <Sidebar
      profiles={[PROFILE]}
      tabs={[host, hiddenReviewer]}
      installedCliVersion="1.0.114"
      activeProfileId={PROFILE.id}
      activeTabId="tab-1"
      canOpenTab
      collapsed
      onToggleCollapsed={noop}
      onSelectWorkspace={noop}
      onActivateProfile={noop}
      onRemoveProfile={noop}
      onActivateTab={noop}
      onPopOutTab={noop}
      onRenameTab={noop}
      onCloseTab={noop}
      onRestartTab={noop}
      onUnloadTab={noop}
      onCreateTab={noop}
      onCreateTabWithAttachments={noop}
      onFanOut={noop}
      onResumePicker={noop}
      onOpenHistory={noop}
      onConnectRemote={noop}
      onOpenSettings={noop}
    />,
  )
  const numberedButtons = collapsedHtml.match(/class="sidebar-session-title"/g) ?? []
  assert.equal(numberedButtons.length, 1, 'collapsed rail only lists the regular host tab, never hidden tempReviewer tabs')
})
