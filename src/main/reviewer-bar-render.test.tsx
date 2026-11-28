import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
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
        id: 'copilot',
        label: 'Copilot CLI',
        cli: 'copilot',
        tabId: 'tab-2',
        verdict: 'reviewing',
        checkedOut: 'a'.repeat(40),
        needsAttention: false,
        error: null,
        keptCheckoutPath: null,
      },
      {
        id: 'claude',
        label: 'Claude Code',
        cli: 'claude',
        tabId: 'tab-3',
        verdict: 'reviewing',
        checkedOut: 'a'.repeat(40),
        needsAttention: true,
        error: null,
        keptCheckoutPath: null,
      },
      {
        id: 'codex',
        label: 'Codex CLI',
        cli: 'codex',
        tabId: null,
        verdict: 'failed',
        checkedOut: 'a'.repeat(40),
        needsAttention: true,
        error: 'Codex exited unexpectedly',
        keptCheckoutPath: null,
      },
      {
        id: 'antigravity',
        label: 'Antigravity CLI',
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
      id: 'copilot',
      label: 'Copilot CLI',
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
      seatId: 'claude', cli: 'claude',
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
  assert.match(expandedHtml, /<details class="sidebar-temp-reviewers" open="">/)
  assert.match(expandedHtml, /Reviewers \(1\)/)
  assert.match(expandedHtml, /Review PR #42 · Claude Code/)

  // Standalone / profile-scoped reviewers (with no regular host tab open) still render under their workspace:
  const standaloneReviewer = makeTab('tab-solo', 'Review PR #42 · Antigravity CLI', {
    cli: 'antigravity',
    tempReviewer: {
      groupId: '22222222-2222-4222-8222-222222222222',
      hostTabId: null,
      seatId: 'antigravity', cli: 'antigravity',
      prLabel: 'PR #42',
      prNumber: 42,
      repository: 'omaha:3001/owner/repo',
      prUrl: 'http://omaha:3001/owner/repo/pulls/42',
    },
  })
  const standaloneHtml = renderToStaticMarkup(
    <Sidebar
      profiles={[PROFILE]}
      tabs={[standaloneReviewer]}
      installedCliVersion="1.0.114"
      activeProfileId={PROFILE.id}
      activeTabId={null}
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
  assert.match(standaloneHtml, /Reviewers \(1\)/)
  assert.match(standaloneHtml, /Review PR #42 · Antigravity CLI/)

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

  // Sidebar highlights the peeked reviewer row via peekTabId without requiring activeTabId to move off the host:
  const peekedSidebarHtml = renderToStaticMarkup(
    <Sidebar
      profiles={[PROFILE]}
      tabs={[host, hiddenReviewer]}
      installedCliVersion="1.0.114"
      activeProfileId={PROFILE.id}
      activeTabId="tab-1"
      peekTabId="tab-2"
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
  assert.equal((peekedSidebarHtml.match(/sidebar-session-active/g) ?? []).length, 2, 'host tab and peeked reviewer are both marked active in sidebar')
})

test('SessionWorkspace strips right-panel/tool/pop-out controls from tempReviewer headers, keeps standalone toolsControl outside, and forwards focusedTabId to SessionTerminal', async () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const entry = join(here, '..', 'renderer', 'components', 'SessionWorkspace.js')
  const tempDir = await mkdtemp(join(tmpdir(), 'session-workspace-render-'))
  try {
    const outFile = join(tempDir, 'session-workspace.mjs')
    await build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: outFile,
      plugins: [{
        name: 'stub-terminal',
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^react(\/jsx-runtime)?$/ }, (args) => ({
            path: import.meta.resolve(args.path),
            external: true,
          }))
          pluginBuild.onResolve({ filter: /SessionTerminal\.js$/ }, () => ({ path: 'stub-session-terminal', namespace: 'stub' }))
          pluginBuild.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            loader: 'js',
            contents: `import { jsx } from 'react/jsx-runtime'; export function SessionTerminal({ tab, active, focused }) { return jsx('div', { 'data-terminal-for': tab.id, 'data-active': String(active), 'data-focused': String(Boolean(focused)) }); }`,
          }))
        },
      }],
    })
    const { SessionWorkspace } = await import(pathToFileURL(outFile).href) as typeof import('../renderer/components/SessionWorkspace.js')
    const noop = (): void => {}
    const host = makeTab('tab-host', 'Host Session')
    const reviewer = makeTab('tab-rev', 'Meeting J984 · Copilot CLI', {
      tempReviewer: {
        groupId: 'g-1',
        hostTabId: 'tab-host',
        seatId: 'copilot',
        cli: 'copilot',
        repository: 'demo-repo',
        prLabel: 'Meeting J984',
        prNumber: null,
        prUrl: null,
        meetingId: 'J984',
      },
    })

    const hostedHtml = renderToStaticMarkup(
      <SessionWorkspace
        tabs={[host, reviewer]}
        activeTabId="tab-host"
        activeProfileId={PROFILE.id}
        peekTabId="tab-rev"
        focusedPeekTabId="tab-rev"
        canOpenTab
        toolsControl={<button type="button" className="session-tools-toggle">+ Tools</button>}
        onActivate={noop}
        onFork={noop}
        onClose={noop}
        onRestart={noop}
        onShowLog={noop}
        onCreate={noop}
        onPopOut={noop}
        onOpenBrowser={noop}
        onToggleGit={noop}
        desktopControlAllowed
        onClearPeek={noop}
      />,
    )
    assert.match(hostedHtml, /aria-label="Temporary reviewer: Meeting J984 · Copilot CLI"/)
    const reviewerPane = hostedHtml.slice(hostedHtml.indexOf('aria-label="Temporary reviewer:'))
    assert.doesNotMatch(reviewerPane, /session-tools-toggle/, 'hosted tempReviewer header omits tools toggle')
    assert.doesNotMatch(reviewerPane, /session-git-toggle/, 'hosted tempReviewer header omits Git toggle')
    assert.doesNotMatch(reviewerPane, /session-browser-toggle/, 'hosted tempReviewer header omits Browser toggle')
    assert.doesNotMatch(reviewerPane, /Open in new window/, 'hosted tempReviewer header omits Pop-out')
    assert.doesNotMatch(reviewerPane, /Desktop control/i, 'hosted tempReviewer header omits Desktop Control')
    assert.equal((hostedHtml.match(/session-tools-toggle/g) ?? []).length, 1, 'only the host pane renders the tools toggle')

    // Focused class AND SessionTerminal focused prop move to the reviewer when focusedPeekTabId is set, and return to host on Hide:
    assert.match(hostedHtml, /session-pane session-pane-visible"[^>]*aria-label="Main session: Host Session"/)
    assert.match(hostedHtml, /session-pane session-pane-visible session-pane-focused"[^>]*aria-label="Temporary reviewer: Meeting J984 · Copilot CLI"/)
    assert.match(hostedHtml, /data-terminal-for="tab-host"[^>]*data-focused="false"/, 'host terminal is unfocused while reviewer is focused')
    assert.match(hostedHtml, /data-terminal-for="tab-rev"[^>]*data-focused="true"/, 'reviewer terminal receives focused=true')

    const returnedToHostHtml = renderToStaticMarkup(
      <SessionWorkspace
        tabs={[host, reviewer]}
        activeTabId="tab-host"
        activeProfileId={PROFILE.id}
        peekTabId={null}
        focusedPeekTabId={null}
        canOpenTab
        toolsControl={<button type="button" className="session-tools-toggle">+ Tools</button>}
        onActivate={noop}
        onFork={noop}
        onClose={noop}
        onRestart={noop}
        onShowLog={noop}
        onCreate={noop}
        onClearPeek={noop}
      />,
    )
    assert.match(returnedToHostHtml, /session-pane session-pane-visible session-pane-focused"[^>]*aria-label="Main session: Host Session"/)
    assert.match(returnedToHostHtml, /data-terminal-for="tab-host"[^>]*data-focused="true"/, 'host terminal regains focused=true on Hide')

    // Standalone peek renders workspace toolsControl outside the reviewer header in row 1, with the reviewer pane in row 2:
    const standaloneReviewer = makeTab('tab-solo', 'Meeting J984 · Claude Code', {
      cli: 'claude',
      tempReviewer: {
        groupId: 'g-2',
        hostTabId: null,
        seatId: 'claude',
        cli: 'claude',
        repository: 'demo-repo',
        prLabel: 'Meeting J984',
        prNumber: null,
        prUrl: null,
        meetingId: 'J984',
      },
    })
    const standaloneHtml = renderToStaticMarkup(
      <SessionWorkspace
        tabs={[standaloneReviewer]}
        activeTabId={null}
        activeProfileId={PROFILE.id}
        peekTabId="tab-solo"
        focusedPeekTabId="tab-solo"
        canOpenTab
        toolsControl={<button type="button" className="session-tools-toggle">+ Tools</button>}
        onActivate={noop}
        onFork={noop}
        onClose={noop}
        onRestart={noop}
        onShowLog={noop}
        onCreate={noop}
        onPopOut={noop}
        onOpenBrowser={noop}
        onToggleGit={noop}
        onClearPeek={noop}
      />,
    )
    assert.match(standaloneHtml, /class="standalone-tools-bar"[^>]*>.*session-tools-toggle/)
    assert.match(standaloneHtml, /grid-template-rows:auto minmax\(0, 1fr\)/)
    assert.match(standaloneHtml, /grid-row:2[^>]*aria-label="Temporary reviewer: Meeting J984 · Claude Code"/)
    const standalonePane = standaloneHtml.slice(standaloneHtml.indexOf('aria-label="Temporary reviewer:'))
    assert.doesNotMatch(standalonePane, /session-tools-toggle/, 'standalone reviewer header itself omits tools toggle')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})
