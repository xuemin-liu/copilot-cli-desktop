import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReviewerBar, reviewerConfirmButtonLabel } from '../renderer/components/ReviewerBar.js'
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

test('ReviewerBar renders per-CLI chips, Peek/Retry/Dismiss controls, and Confirm / Approve anyway button', () => {
  const group: TempReviewerGroupView = {
    id: '22222222-2222-4222-8222-222222222222',
    hostTabId: 'tab-1',
    profileId: PROFILE.id,
    repository: 'owner/repo',
    prNumber: 42,
    prUrl: 'https://github.com/owner/repo/pull/42',
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    stage: 'active',
    outcome: null,
    seats: [
      {
        cli: 'copilot',
        tabId: 'tab-2',
        verdict: 'approved',
        checkedOut: 'a'.repeat(40),
        ranChecks: ['npm test'],
        missingChecks: [],
        needsAttention: false,
        error: null,
        keptCheckoutPath: null,
      },
      {
        cli: 'claude',
        tabId: 'tab-3',
        verdict: 'held-approval',
        checkedOut: 'a'.repeat(40),
        ranChecks: ['static-source-and-diff-review'],
        missingChecks: ['local build and test suite'],
        needsAttention: false,
        error: null,
        keptCheckoutPath: null,
      },
      {
        cli: 'codex',
        tabId: null,
        verdict: 'failed',
        checkedOut: 'a'.repeat(40),
        ranChecks: [],
        missingChecks: [],
        needsAttention: true,
        error: 'Codex sandbox failed',
        keptCheckoutPath: null,
      },
    ],
    confirmTarget: null,
    notice: null,
  }

  const activeHtml = renderToStaticMarkup(
    <ReviewerBar groups={[group]} activeTabId="tab-1" peekTabId="tab-2" onPeek={() => {}} onError={() => {}} />,
  )
  assert.match(activeHtml, /PR #42/)
  assert.match(activeHtml, /Copilot CLI/)
  assert.match(activeHtml, /Claude Code/)
  assert.match(activeHtml, /Codex CLI/)
  assert.match(activeHtml, /Hide/)
  assert.match(activeHtml, /Peek/)
  assert.match(activeHtml, /Retry/)
  assert.match(activeHtml, /Dismiss/)
  assert.doesNotMatch(activeHtml, /Confirm approval/)

  const readyGroup: TempReviewerGroupView = {
    ...group,
    seats: group.seats.slice(0, 2),
    confirmTarget: {
      groupId: group.id,
      head: group.head,
      base: group.base,
      rosterKey: 'copilot:g1,claude:g2',
      feedbackSignature: 'sig',
      approveAnyway: true,
      missingChecks: [{ cli: 'claude', missing: ['local build and test suite'] }],
    },
  }
  assert.match(reviewerConfirmButtonLabel(readyGroup.confirmTarget!), /Approve anyway \(missing: Claude Code: local build and test suite\)/)
  const readyHtml = renderToStaticMarkup(
    <ReviewerBar groups={[readyGroup]} activeTabId="tab-1" peekTabId={null} onPeek={() => {}} onError={() => {}} />,
  )
  assert.match(readyHtml, /Approve anyway/)

  // When focus moves into the peeked reviewer terminal (activeTabId === 'tab-2'), Hide and Peek remain available:
  const focusedOnReviewerHtml = renderToStaticMarkup(
    <ReviewerBar groups={[readyGroup]} activeTabId="tab-2" peekTabId="tab-2" onPeek={() => {}} onError={() => {}} />,
  )
  assert.match(focusedOnReviewerHtml, /Hide/)
  assert.match(focusedOnReviewerHtml, /Peek/)

  const unrelatedHtml = renderToStaticMarkup(
    <ReviewerBar groups={[readyGroup]} activeTabId="tab-99" peekTabId={null} onPeek={() => {}} onError={() => {}} />,
  )
  assert.equal(unrelatedHtml, '')
})

test('Sidebar hides tempReviewer tabs from main session lists and tucks them into a Reviewers disclosure under the host tab', () => {
  const host = makeTab('tab-1', 'Fix PR #42')
  const hiddenReviewer = makeTab('tab-2', 'Review #42 · Claude Code', {
    cli: 'claude',
    tempReviewer: {
      groupId: '22222222-2222-4222-8222-222222222222',
      hostTabId: 'tab-1',
      cli: 'claude',
      prNumber: 42,
      repository: 'owner/repo',
      prUrl: 'https://github.com/owner/repo/pull/42',
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
  assert.doesNotMatch(collapsedHtml, /Review #42 · Claude Code/)
})
