import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { GitDiffView, diffChangeSignature, diffCommentKey, diffLineKind, numberDiffLines } from '../renderer/components/GitDiffView.js'
import { GitPanel, RepoRow, canDiscard, draftOf } from '../renderer/components/GitPanel.js'
import { GitCommitBox, commitBlocker } from '../renderer/components/GitCommitBox.js'
import type { AmendState } from '../renderer/components/GitCommitBox.js'
import { GitReviewCard } from '../renderer/components/GitReviewCard.js'
import { GitResolveBar, folderWithin, resolveBlocker } from '../renderer/components/GitResolveBar.js'
import type { GitResolveBarProps } from '../renderer/components/GitResolveBar.js'
import { GitSyncBar, pullBlocker, pushBlocker } from '../renderer/components/GitSyncBar.js'
import type { GitSyncBarProps } from '../renderer/components/GitSyncBar.js'
import { GitBranchList, upstreamLabel } from '../renderer/components/GitBranchList.js'
import { GitWorktreeList, removeBlocker, worktreeFlags } from '../renderer/components/GitWorktreeList.js'
import type { GitBranchListProps } from '../renderer/components/GitBranchList.js'
import { GIT_PANEL_MIN_WIDTH, ProjectDock, SESSION_MIN_WIDTH, dockLayout } from '../renderer/components/ProjectDock.js'
import type { GitBranchView, GitDiffView as GitDiff, GitRepoSummary, GitWorktreeView } from './git-types.js'

const diff = (text: string, extra: Partial<GitDiff> = {}): GitDiff => ({ entryId: 'e1-0', path: 'a.ts', kind: 'text', text, truncated: false, added: 1, deleted: 1, ...extra })

test('the panel never squeezes the session area below its minimum', () => {
  assert.deepEqual(dockLayout(1400, 420), { panelWidth: 420, takeover: false })
  assert.deepEqual(dockLayout(1400, 100), { panelWidth: GIT_PANEL_MIN_WIDTH, takeover: false }, 'a stored width below the minimum is raised')
  const wide = dockLayout(1000, 900)
  assert.equal(wide.takeover, false)
  assert.equal(wide.panelWidth, 1000 - SESSION_MIN_WIDTH - 6, 'a stored width that is too large is cut back')
  assert.equal(dockLayout(0, 420).takeover, false, 'unmeasured: do not take over')
})

test('a window too narrow for both lets the panel replace the session area', () => {
  const narrowest = GIT_PANEL_MIN_WIDTH + SESSION_MIN_WIDTH + 6
  assert.equal(dockLayout(narrowest, 420).takeover, false)
  assert.deepEqual(dockLayout(narrowest - 1, 420), { panelWidth: null, takeover: true })
  assert.equal(dockLayout(600, 420).takeover, true)
})

test('diff lines are classified for colouring', () => {
  assert.equal(diffLineKind('@@ -1,2 +1,2 @@'), 'hunk')
  assert.equal(diffLineKind('+added'), 'add')
  assert.equal(diffLineKind('-removed'), 'del')
  assert.equal(diffLineKind('+++ b/a.ts'), 'meta')
  assert.equal(diffLineKind('--- a/a.ts'), 'meta')
  assert.equal(diffLineKind('diff --git a/a b/a'), 'meta')
  assert.equal(diffLineKind('index 123..456 100644'), 'meta')
  assert.equal(diffLineKind(' context'), 'context')
  assert.equal(diffLineKind(''), 'context')
})

test('diff content is shown as text and never parsed as markup', () => {
  const hostile = '+<img src=x onerror="alert(1)"><script>alert(2)</script>\n-<b>bold</b> &amp; "quotes"'
  const html = renderToStaticMarkup(<GitDiffView diff={diff(hostile)} />)
  assert.doesNotMatch(html, /<img|<script|<b>/)
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/)
  assert.match(html, /&amp;amp;/)
  assert.match(html, /git-diff-add/)
  assert.match(html, /git-diff-del/)
})

test('non-text diffs show a plain notice', () => {
  for (const [kind, text] of [['binary', /Binary file/], ['directory', /Untracked folder/], ['too-large', /too large/], ['empty', /No textual change/]] as const) {
    assert.match(renderToStaticMarkup(<GitDiffView diff={diff('', { kind })} />), text, kind)
  }
})

test('a long diff renders a bounded number of lines and says so', () => {
  const lines = Array.from({ length: 5_000 }, (_item, index) => `+line ${index}`).join('\n')
  const html = renderToStaticMarkup(<GitDiffView diff={diff(lines)} />)
  assert.equal(html.match(/git-diff-line /g)?.length, 4_000)
  assert.match(html, /Showing the first 4,000 of 5,000 lines/)
  assert.match(renderToStaticMarkup(<GitDiffView diff={diff('+a', { truncated: true })} />), /larger than the panel reads/)
})

test('the dock keeps the session area mounted and adds the panel only when open', () => {
  const render = (open: boolean): string => renderToStaticMarkup(
    <ProjectDock open={open} width={420} onWidthChange={() => undefined} panel={() => <aside id="panel">panel</aside>}><div id="session">session</div></ProjectDock>)
  assert.match(render(false), /id="session"/)
  assert.doesNotMatch(render(false), /id="panel"/)
  assert.match(render(true), /id="session"/)
  assert.match(render(true), /id="panel"/)
})

test('the panel starts in a loading state with its controls labelled', () => {
  const html = renderToStaticMarkup(<GitPanel profileId="0123456789abcdef" promptTarget={null} onClose={() => undefined} />)
  assert.match(html, /aria-label="Git"/)
  assert.match(html, /Looking for repositories/)
  assert.match(html, /aria-label="Rescan repositories"/)
  assert.match(html, /aria-label="Close Git panel"/)
  const narrow = renderToStaticMarkup(<GitPanel profileId="0123456789abcdef" promptTarget={null} takeover onClose={() => undefined} />)
  assert.match(narrow, /Close Git panel and return to the session/)
})

test('the review card shows every setting in full, with hidden padding spelled out', () => {
  const hidden = `cat${' '.repeat(220)}; echo HIDDEN-COMMAND > review-marker.txt`
  const html = renderToStaticMarkup(<GitReviewCard items={[{ key: 'filter.review.clean', value: hidden }]} working={false} onTrust={() => undefined} />)
  assert.match(html, /HIDDEN-COMMAND &gt; review-marker\.txt/, 'the command after the padding is on screen')
  assert.match(html, /⟦220 spaces⟧/)
  assert.match(html, /223 characters|2\d\d characters, shown in full/)
  assert.doesNotMatch(html, /cat …|cat…/, 'nothing is cut short')
  assert.doesNotMatch(html, /<button[^>]*disabled/, 'a reviewable setting can be trusted')
})

test('review card values are text, with line breaks and invisible characters named', () => {
  const html = renderToStaticMarkup(<GitReviewCard items={[{ key: 'core.sshcommand', value: `ssh\n<script>alert(1)</script>${String.fromCharCode(0x200b)}` }]} working={false} onTrust={() => undefined} />)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /ssh⟦newline⟧&lt;script&gt;alert\(1\)&lt;\/script&gt;⟦U\+200B⟧/)
})

test('a setting too long to review cannot be trusted from the card', () => {
  const html = renderToStaticMarkup(<GitReviewCard items={[{ key: 'filter.big.clean', value: 'x'.repeat(8_001) }]} working={false} onTrust={() => undefined} />)
  assert.match(html, /too long to review properly/)
  assert.match(html, /<button[^>]*disabled[^>]*>Trust this repository/)
  assert.match(renderToStaticMarkup(<GitReviewCard items={[{ key: 'a.b', value: 'c' }]} working onTrust={() => undefined} />), /<button[^>]*disabled/, 'also disabled while a request is in flight')
})

const commitBox = (overrides: Partial<Parameters<typeof GitCommitBox>[0]> = {}): string => renderToStaticMarkup(
  <GitCommitBox stagedCount={2} conflictCount={0} message="feat: a thing" onMessageChange={() => undefined} busy={null} progress="" canDraft draftTitle="draft"
    onDraft={() => undefined} onCommit={() => undefined} onCancel={() => undefined} hooks={null} onApproveHooks={() => undefined} onDismissHooks={() => undefined} amend={null} onToggleAmend={() => undefined} {...overrides} />)

test('Commit says exactly what it is waiting for', () => {
  assert.equal(commitBlocker(2, 0, 'msg'), null)
  assert.match(commitBlocker(0, 0, 'msg') ?? '', /Stage the files/)
  assert.match(commitBlocker(2, 0, '   ') ?? '', /Write a commit message/)
  assert.match(commitBlocker(2, 1, 'msg') ?? '', /Resolve the conflicts/)
  assert.match(commitBlocker(0, 1, '') ?? '', /Resolve the conflicts/, 'conflicts come first')
})

test('the commit box offers Commit with the file count, and disables it with a reason when it cannot', () => {
  const ready = commitBox()
  assert.match(ready, /Commit 2 files/)
  assert.doesNotMatch(ready, /<button[^>]*disabled[^>]*>Commit 2 files/)
  assert.match(commitBox({ stagedCount: 1 }), /Commit 1 file</)
  const empty = commitBox({ message: '' })
  assert.match(empty, /<button[^>]*disabled[^>]*>Commit 2 files/)
  assert.match(empty, /Write a commit message\./)
  assert.match(commitBox({ stagedCount: 0 }), /Stage the files you want to commit\./)
  assert.match(commitBox({ conflictCount: 2 }), /Resolve the conflicts/)
})

test('while Git works the box shows its output, offers Cancel and locks the message', () => {
  const working = commitBox({ busy: 'commit', progress: 'lint: checking 12 files\n' })
  assert.match(working, /Committing…/)
  assert.match(working, />Cancel</)
  assert.match(working, /lint: checking 12 files/)
  assert.match(working, /<textarea[^>]*disabled/)
  assert.doesNotMatch(commitBox(), />Cancel</, 'nothing to cancel when idle')
  assert.doesNotMatch(commitBox({ busy: 'stage', progress: '' }), /git-progress/, 'no empty output box')
})

test('an unapproved hook is named in full and must be allowed before the commit goes ahead', () => {
  const html = commitBox({ hooks: ['pre-commit', `evil${String.fromCharCode(0x200b)}-hook`] })
  assert.match(html, /role="alertdialog"/)
  assert.match(html, /pre-commit, evil⟦U\+200B⟧-hook/, 'an invisible character in a hook name is spelled out')
  assert.match(html, />Allow these hooks and commit</)
  assert.match(html, /Don&#x27;t commit|Don&rsquo;t commit|Don’t commit/)
  assert.match(html, /<button[^>]*disabled[^>]*>Commit 2 files/, 'Commit itself waits for the approval')
})

const summary = (overrides: Partial<GitRepoSummary> = {}): GitRepoSummary => ({
  id: 'repo-2', name: 'beta', relativePath: 'beta', folder: 'D:\\one\\beta', merging: false, resolver: null, kind: 'nested', state: 'ready', branch: 'main', detached: false, upstream: null, ahead: null, behind: null,
  changeCount: 0, generation: 1, headOid: null, error: null, reviewItems: [], worktreeOf: null, configHash: null, ...overrides,
})

test('a repository row is disabled, with the reason, while a write runs elsewhere', () => {
  const idle = renderToStaticMarkup(<RepoRow repo={summary()} selected={false} onSelect={() => undefined} />)
  assert.doesNotMatch(idle, /<button[^>]*disabled/)
  const locked = renderToStaticMarkup(<RepoRow repo={summary()} selected={false} disabled onSelect={() => undefined} />)
  assert.match(locked, /<button[^>]*disabled/)
  assert.match(locked, /Wait for the running Git operation to finish, or cancel it/)
})

const syncBar = (extra: Partial<GitSyncBarProps> = {}): string => renderToStaticMarkup(
  <GitSyncBar upstream="origin/main" ahead={2} behind={3} noBranch={false} locked={false} running={null} progress="" publish={null}
    onSync={() => undefined} onChooseRemote={() => undefined} onPublish={() => undefined} onDismissPublish={() => undefined} onCancel={() => undefined} {...extra} />)

test('the sync bar offers Fetch, Pull and Push with the commit counts, and says why one is unavailable', () => {
  const ready = syncBar()
  assert.match(ready, />Fetch</)
  assert.match(ready, />Pull ↓3</)
  assert.match(ready, />Push ↑2</)
  assert.doesNotMatch(ready, /<button[^>]*disabled/)
  assert.doesNotMatch(ready, />Cancel</, 'nothing to cancel when idle')
  assert.match(syncBar({ behind: 0 }), /<button[^>]*disabled[^>]*>Pull</)
  assert.match(syncBar({ ahead: 0 }), /<button[^>]*disabled[^>]*>Push</)
  assert.equal(pullBlocker('origin/main', 0, false), 'Nothing to pull. Fetch first to look for new commits.')
  assert.equal(pullBlocker(null, 0, false), 'This branch has no upstream to pull from.')
  assert.equal(pushBlocker('origin/main', 0, false), 'Nothing to push.')
  assert.match(pullBlocker('origin/main', 2, true) ?? '', /no current branch/)
  assert.match(pushBlocker(null, 0, true) ?? '', /no current branch/)
})

test('a branch with no upstream offers Publish instead of Push, even with nothing ahead', () => {
  const bar = syncBar({ upstream: null, ahead: 0, behind: 0 })
  assert.match(bar, />Publish…</)
  assert.doesNotMatch(bar, /<button[^>]*disabled[^>]*>Publish/)
  assert.match(bar, /<button[^>]*disabled[^>]*>Pull</)
})

test('while a network command runs everything is locked except Cancel, which comes with the output', () => {
  const running = syncBar({ locked: true, running: 'fetch', progress: 'Receiving objects: 40%\n' })
  assert.match(running, />Fetching…</)
  assert.match(running, />Cancel</)
  assert.match(running, /Receiving objects: 40%/)
  assert.equal((running.match(/<button[^>]*disabled/g) ?? []).length, 3, 'Fetch, Pull and Push are all locked')
  assert.match(syncBar({ locked: true, running: 'push' }), />Pushing…</)
  assert.doesNotMatch(syncBar({ locked: true, running: null }), />Cancel</, 'a stage or commit has its own Cancel')
})

test('publishing a branch names the branch and the remote, and is a separate confirmation', () => {
  const asking = syncBar({ upstream: null, publish: { branch: 'feature/x', remotes: ['origin', 'fork'], remote: 'fork' } })
  assert.match(asking, /Publish “feature\/x”\?/)
  assert.match(asking, /not on any remote yet/)
  assert.match(asking, /<option value="fork" selected="">fork<\/option>/)
  assert.match(asking, /Publish to fork</)
  assert.match(asking, />Not now</)
  assert.doesNotMatch(syncBar(), /alertdialog/, 'no prompt unless a push asked for one')
})

const branch = (extra: Partial<GitBranchView> = {}): GitBranchView => ({ name: 'main', current: false, oid: 'a'.repeat(40), upstream: 'origin/main', ahead: 0, behind: 0, upstreamGone: false, subject: 'work', committedAt: 1, ...extra })
const branchList = (extra: Partial<GitBranchListProps> = {}): string => renderToStaticMarkup(
  <GitBranchList branches={[branch({ name: 'main', current: true }), branch({ name: 'feature/x', upstream: null, ahead: null, behind: null, subject: 'in progress' })]} error={null}
    locked={false} lockedReason={null} newName="" onNewNameChange={() => undefined} onCreate={() => undefined} onSwitch={() => undefined} {...extra} />)

test('the branch list marks the current branch, offers Switch for the others, and shows how far each is from its upstream', () => {
  const list = branchList()
  assert.match(list, /git-branch-current[^>]*>.*main.*current/s)
  assert.equal((list.match(/>Switch</g) ?? []).length, 1, 'no Switch for the current branch')
  assert.match(list, /aria-label="Switch to feature\/x"/)
  assert.match(list, /local only/)
  assert.match(list, /origin\/main · in sync/)
  assert.equal(upstreamLabel(branch({ ahead: 2, behind: 1 })), 'origin/main ↑2 ↓1')
  assert.equal(upstreamLabel(branch({ ahead: 0, behind: 3 })), 'origin/main ↓3')
  assert.equal(upstreamLabel(branch({ upstreamGone: true })), 'upstream gone')
  assert.equal(upstreamLabel(branch({ upstream: null, ahead: null, behind: null })), 'local only')
})

test('branch names from a repository are shown as text, never as markup', () => {
  const list = branchList({ branches: [branch({ name: '<img src=x onerror=alert(1)>', subject: '<script>boom</script>' })] })
  assert.doesNotMatch(list, /<img|<script/)
  assert.match(list, /&lt;img/)
})

test('creating a branch needs a valid name, and everything is locked while a write runs', () => {
  assert.match(branchList({ newName: '' }), /<button[^>]*disabled[^>]*>Create and switch/)
  assert.doesNotMatch(branchList({ newName: 'idea' }), /<button[^>]*disabled[^>]*>Create and switch/)
  const bad = branchList({ newName: 'has space' })
  assert.match(bad, /<button[^>]*disabled[^>]*>Create and switch/)
  assert.match(bad, /cannot contain spaces/)
  const locked = branchList({ newName: 'idea', locked: true })
  assert.match(locked, /<button[^>]*disabled[^>]*>Create and switch/)
  assert.match(locked, /<button[^>]*disabled[^>]*>Switch</)
  assert.match(branchList({ locked: true, lockedReason: 'There are no commits yet.' }), /There are no commits yet\./)
})

test('the branch list says when it is loading, empty, or failed', () => {
  assert.match(branchList({ branches: null }), /Loading branches…/)
  assert.match(branchList({ branches: [] }), /No branches yet\./)
  assert.match(branchList({ branches: null, error: 'git failed' }), /git failed/)
  assert.doesNotMatch(branchList({ branches: null, error: 'git failed' }), /Loading branches/)
})

test('Discard applies to working-tree changes and untracked items, not to conflicts, submodules or added-only files', () => {
  const entry = (kind: GitRepoSummary['kind'] extends never ? never : 'changed' | 'renamed' | 'unmerged' | 'untracked' | 'ignored', worktree: string, submodule = false) =>
    ({ kind, worktree: worktree as never, submodule })
  for (const yes of [entry('changed', 'M'), entry('changed', 'T'), entry('changed', 'D'), entry('renamed', 'M'), entry('untracked', '?')]) assert.equal(canDiscard(yes), true, JSON.stringify(yes))
  for (const no of [entry('changed', 'A'), entry('changed', '.'), entry('renamed', 'D'), entry('unmerged', 'U'), entry('ignored', '!'), entry('changed', 'M', true)]) assert.equal(canDiscard(no), false, JSON.stringify(no))
})

test('a draft message is only ever the one kept for that repository, whatever the folder is called', () => {
  assert.equal(draftOf({}, 'app'), '')
  assert.equal(draftOf({ app: 'feat: x' }, 'app'), 'feat: x')
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(draftOf({}, name), '', `nothing is kept for ${name}`)
    assert.equal(draftOf({ ['__proto__']: 'kept for the folder named __proto__', [name]: 'draft' }, name), 'draft', name)
  }
  assert.equal(draftOf({ ['__proto__']: 'kept for the folder named __proto__' }, '__proto__'), 'kept for the folder named __proto__')
})

const amendOn = (extra: Partial<AmendState> = {}): AmendState => ({ on: true, loading: false, lastMessage: 'fix: the old message', publishedTo: [], isMerge: false, ...extra })

test('Amend is offered only when there is a commit, and says what it will do', () => {
  assert.doesNotMatch(commitBox(), /Amend the last commit/, 'no checkbox without a commit to amend')
  const off = commitBox({ amend: amendOn({ on: false, lastMessage: null }) })
  assert.match(off, /Amend the last commit/)
  assert.doesNotMatch(off, /<input[^>]*checked/)
  assert.match(off, />Commit 2 files</)
  const on = commitBox({ amend: amendOn(), message: 'fix: better message' })
  assert.match(on, /<input[^>]*checked/)
  assert.match(on, />Amend commit \(\+2 files\)</)
  assert.match(on, /aria-label="Message for the amended commit"/)
  assert.match(commitBox({ amend: amendOn(), stagedCount: 0, message: 'reworded' }), />Amend commit</, 'a message-only amend has no file count')
})

test('Amend says why it is unavailable: loading, a merge, a published commit, or nothing to change', () => {
  const blocker = (amend: AmendState, staged = 1, message = 'new message'): string | null => commitBlocker(staged, 0, message, amend)
  assert.equal(blocker(amendOn()), null)
  assert.equal(blocker(amendOn(), 0, 'reworded'), null, 'a changed message is enough')
  assert.match(blocker(amendOn({ loading: true })) ?? '', /Loading the last commit/)
  assert.match(blocker(amendOn({ lastMessage: null })) ?? '', /Loading the last commit/)
  assert.match(blocker(amendOn({ isMerge: true })) ?? '', /is a merge/)
  assert.match(blocker(amendOn({ publishedTo: ['origin/main', 'origin/dev'] })) ?? '', /already on origin\/main, origin\/dev.*force push/)
  assert.match(blocker(amendOn(), 0, 'fix: the old message') ?? '', /Stage files, or change the message/)
  assert.match(blocker(amendOn(), 1, '   ') ?? '', /Write a commit message/)
  assert.match(commitBlocker(1, 2, 'm', amendOn()) ?? '', /Resolve the conflicts/)
  // The button is disabled with the reason shown.
  const published = commitBox({ amend: amendOn({ publishedTo: ['origin/main'] }) })
  assert.match(published, /<button[^>]*disabled[^>]*>Amend commit/)
  assert.match(published, /already on origin\/main/)
  // Ordinary commits are unchanged.
  assert.equal(commitBlocker(0, 0, 'msg', amendOn({ on: false })), 'Stage the files you want to commit.')
})

test('an amend that needs hook approval says so', () => {
  const html = commitBox({ amend: amendOn(), hooks: ['post-rewrite', 'pre-commit'] })
  assert.match(html, /hooks that an amend would run/)
  assert.match(html, />Allow these hooks and amend</)
  assert.match(html, />Don.t amend</)
})

test('diff lines get their file line numbers from the hunk headers; headers, metadata and no-newline markers get none', () => {
  const numbered = numberDiffLines([
    'diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -10,3 +10,4 @@ function f() {', ' context', '-removed', '+added one', '+added two', ' tail', '\\ No newline at end of file',
    '@@ -0,0 +1 @@', '+brand new',
  ])
  assert.deepEqual(numbered.map(line => [line.kind, line.oldLine, line.newLine]), [
    ['meta', null, null], ['meta', null, null], ['meta', null, null], ['hunk', null, null],
    ['context', 10, 10], ['del', 11, null], ['add', null, 11], ['add', null, 12], ['context', 12, 13], ['context', null, null],
    ['hunk', null, null], ['add', null, 1],
  ])
  assert.deepEqual(numberDiffLines(['+before any hunk header']).map(line => [line.oldLine, line.newLine]), [[null, null]])
  assert.deepEqual(numbered.map(diffCommentKey), [null, null, null, null, 'new:10', 'old:11', 'new:11', 'new:12', 'new:13', null, null, 'new:1'])
})

test('a line position and the change signature do not depend on how much context the diff carries', () => {
  const hunks = ['--- a/a.ts', '+++ b/a.ts', '@@ -3,3 +3,3 @@', ' c', '-d', '+D', ' e']
  const whole = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,6 +1,6 @@', ' a', ' b', ' c', '-d', '+D', ' e', ' f']
  const at = (lines: string[], kind: string) => numberDiffLines(lines).find(line => line.kind === kind)?.position
  assert.equal(at(hunks, 'del'), 3.5, 'a deleted line sits just before the new line that follows it')
  assert.equal(at(hunks, 'add'), 4)
  assert.equal(at(whole, 'del'), at(hunks, 'del'))
  assert.equal(at(whole, 'add'), at(hunks, 'add'))
  assert.equal(diffChangeSignature(whole.join('\n')), diffChangeSignature(hunks.join('\n')))
  assert.notEqual(diffChangeSignature(whole.join('\n').replace('+D', '+X')), diffChangeSignature(hunks.join('\n')))
})

test('with comments enabled, numbered lines get a gutter button and existing comments are shown as text under their line', () => {
  const text = '@@ -1,2 +1,3 @@\n context\n-gone\n+<b>new</b>\n\\ No newline at end of file'
  const items = new Map([['new:2', '<img src=x onerror="alert(1)"> make this `safe`'], ['old:2', 'why remove?']])
  const html = renderToStaticMarkup(<GitDiffView diff={diff(text)} comments={{ items, onChange: () => undefined }} />)
  assert.equal(html.match(/git-diff-gutter/g)?.length, 3, 'context, deleted and added lines can be commented; the header and marker cannot')
  assert.equal(html.match(/git-diff-row-commented/g)?.length, 2)
  assert.match(html, /aria-label="Comment on line 1"/)
  assert.match(html, /aria-label="Comment on old line 2"/)
  assert.match(html, /aria-label="Comment on line 2"/)
  assert.doesNotMatch(html, /<img|<b>/)
  assert.match(html, /git-diff-comment-text">&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; make this `safe`</)
  assert.match(html, /git-diff-comment-text">why remove\?</)
  assert.match(html, /title="Edit the comment on this line">✎</)
  assert.equal(html.match(/>\+<\/button>/g)?.length, 1, 'the uncommented line offers a plus')
  const plain = renderToStaticMarkup(<GitDiffView diff={diff(text)} />)
  assert.doesNotMatch(plain, /git-diff-gutter|git-diff-comment/, 'without the comments prop the diff is read-only')
  const cut = renderToStaticMarkup(<GitDiffView diff={diff('+a', { truncated: true })} comments={{ items: new Map(), onChange: () => undefined }} />)
  assert.match(cut, /Lines past this point cannot be commented on/)
})

test('inside a hunk, content starting with +++ or --- is an added or deleted line, not a file header, and counts advance', () => {
  const numbered = numberDiffLines(['--- a/x.c', '+++ b/x.c', '@@ -1,2 +1,2 @@', '---i;', '-old();', '+++i;', '+new();', '--- a/next-file', '+++ b/next-file'])
  assert.deepEqual(numbered.map(line => [line.kind, line.oldLine, line.newLine]), [
    ['meta', null, null], ['meta', null, null], ['hunk', null, null],
    ['del', 1, null], ['del', 2, null], ['add', null, 1], ['add', null, 2],
    ['meta', null, null], ['meta', null, null],
  ])
  assert.deepEqual(numberDiffLines(['@@ -5 +5 @@', '-a', '+b', 'diff --git a/y b/y']).map(line => [line.kind, line.oldLine, line.newLine]),
    [['hunk', null, null], ['del', 5, null], ['add', null, 5], ['meta', null, null]], 'a header without counts is one line each side')
  const html = renderToStaticMarkup(<GitDiffView diff={diff('@@ -1,1 +1,1 @@\n---i;\n+++i;')} comments={{ items: new Map(), onChange: () => undefined }} />)
  assert.equal(html.match(/git-diff-gutter/g)?.length, 2, 'both content lines can be commented')
  assert.match(html, /git-diff-del[^>]*>.*aria-label="Comment on old line 1"/)
  assert.match(html, /git-diff-add[^>]*>.*aria-label="Comment on line 1"/)
})

test('a worktree repository row says so, and the worktree list names branch, folder, flags and the session using it', () => {
  const summary: GitRepoSummary = {
    id: 'repo-2', name: 'desktop-fix-login-abc123', relativePath: 'D:\\one.worktrees\\desktop-fix-login-abc123', folder: 'D:\\one.worktrees\\desktop-fix-login-abc123', merging: false, resolver: null, kind: 'worktree', worktreeOf: 'repo-1', state: 'ready',
    branch: 'desktop-fix-login-abc123', detached: false, upstream: null, ahead: null, behind: null, changeCount: 1, generation: 1, headOid: 'a'.repeat(40),
    error: null, reviewItems: [], configHash: null,
  }
  const row = renderToStaticMarkup(<RepoRow repo={summary} selected onSelect={() => undefined} />)
  assert.match(row, /git-repo-name">desktop-fix-login-abc123<em> \(worktree\)<\/em>/)
  assert.match(row, /title="D:\\one\.worktrees\\desktop-fix-login-abc123"/)
  const worktrees: GitWorktreeView[] = [
    { path: 'D:\\one', head: 'a'.repeat(40), branch: 'main', detached: false, bare: false, locked: null, prunable: null, main: true, current: false, merged: null },
    { path: 'D:\\one.worktrees\\desktop-fix-login-abc123', head: 'b'.repeat(40), branch: 'desktop-fix-login-abc123', detached: false, bare: false, locked: 'reason <b>here</b>', prunable: null, main: false, current: true, merged: true },
    { path: 'D:\\one.worktrees\\old', head: 'c'.repeat(40), branch: null, detached: true, bare: false, locked: null, prunable: 'gitdir file points to non-existent location', main: false, current: false, merged: true },
  ]
  const sessions = [{ path: 'd:\\one.worktrees\\desktop-fix-login-abc123\\', title: 'Fix login' }]
  assert.deepEqual(worktreeFlags(worktrees[0]!, sessions), ['main worktree'])
  assert.deepEqual(worktreeFlags(worktrees[1]!, sessions), ['locked: reason <b>here</b>', 'used by Fix login'])
  assert.deepEqual(worktreeFlags(worktrees[2]!, sessions), ['detached', 'prunable: gitdir file points to non-existent location'])
  const html = renderToStaticMarkup(<GitWorktreeList worktrees={worktrees} error={null} sessions={sessions} />)
  assert.match(html, /git-worktree-row git-worktree-current/)
  assert.match(html, /git-branch-badge">shown</)
  assert.match(html, /used by Fix login/)
  assert.match(html, /detached at ccccccc/)
  assert.doesNotMatch(html, /<b>here<\/b>/, 'a lock reason from git is text, never markup')
  assert.match(html, /&lt;b&gt;here&lt;\/b&gt;/)
  assert.match(renderToStaticMarkup(<GitWorktreeList worktrees={[worktrees[0]!]} error={null} sessions={[]} />), /No linked worktrees/)
  assert.match(renderToStaticMarkup(<GitWorktreeList worktrees={null} error={null} sessions={[]} />), /Loading worktrees/)
  assert.match(renderToStaticMarkup(<GitWorktreeList worktrees={null} error="git failed" sessions={[]} />), /git failed/)
})

test('Remove is offered only for a merged, unlocked, unused worktree that is not the main one or the one shown, with the reason otherwise', () => {
  const base: GitWorktreeView = { path: 'D:\\one.worktrees\\done', head: 'b'.repeat(40), branch: 'desktop-done-abc123', detached: false, bare: false, locked: null, prunable: null, main: false, current: false, merged: true }
  const sessions = [{ path: 'D:\\one.worktrees\\busy', title: 'Busy one' }]
  assert.equal(removeBlocker(base, sessions), null)
  assert.match(removeBlocker({ ...base, main: true }, sessions) ?? '', /main worktree/)
  assert.match(removeBlocker({ ...base, current: true }, sessions) ?? '', /shown in the panel/)
  assert.match(removeBlocker({ ...base, locked: 'locked' }, sessions) ?? '', /locked/)
  assert.match(removeBlocker({ ...base, prunable: 'gone' }, sessions) ?? '', /prunable/)
  assert.match(removeBlocker({ ...base, merged: null }, sessions) ?? '', /no default branch/)
  assert.match(removeBlocker({ ...base, merged: false }, sessions) ?? '', /not merged/)
  assert.match(removeBlocker({ ...base, path: 'd:\\one.worktrees\\busy\\' }, sessions) ?? '', /used by Busy one/)
  const main: GitWorktreeView = { ...base, path: 'D:\\one', branch: 'main', main: true, merged: null }
  const html = renderToStaticMarkup(<GitWorktreeList worktrees={[main, base, { ...base, path: 'D:\\one.worktrees\\wip', branch: 'wip', merged: false }]} error={null} sessions={sessions} onRemove={() => undefined} />)
  assert.equal(html.match(/git-worktree-remove/g)?.length, 2, 'the main worktree has no button at all')
  assert.match(html, /aria-label="Remove worktree desktop-done-abc123" title="Delete this worktree/)
  assert.doesNotMatch(html, /aria-label="Remove worktree desktop-done-abc123" disabled/)
  assert.match(html, /disabled="" aria-label="Remove worktree wip" title="Its branch is not merged/)
  const busy = renderToStaticMarkup(<GitWorktreeList worktrees={[main, base]} error={null} sessions={sessions} onRemove={() => undefined} locked />)
  assert.match(busy, /disabled="" aria-label="Remove worktree desktop-done-abc123"/, 'everything is locked while a write runs')
  assert.doesNotMatch(renderToStaticMarkup(<GitWorktreeList worktrees={[main, base]} error={null} sessions={sessions} />), /git-worktree-remove/, 'without a handler nothing is offered')
})

const resolveBar = (overrides: Partial<GitResolveBarProps> = {}): string => renderToStaticMarkup(
  <GitResolveBar situation="diverged" branch="main" upstream="origin/main" folder="D:\one" target={{ title: 'Fix login' }} outside={false} blocker={null} onResolve={() => undefined} {...overrides} />)

test('Resolve with Copilot says what Copilot will do, and where', () => {
  const ready = resolveBar()
  assert.match(ready, /merge origin\/main into main and resolve any conflicts/)
  assert.doesNotMatch(ready, /<button[^>]*disabled[^>]*>Resolve with Copilot/)
  assert.match(ready, /title="Ask “Fix login” to do it in D:\\one\. It merges and commits, but never pushes/)
  assert.match(resolveBar({ situation: 'local-changes' }), /ask you what to do with them/)
  assert.match(resolveBar({ situation: 'conflicts' }), /resolve these conflicts and finish the merge/)
  const outside = resolveBar({ outside: true })
  assert.match(outside, /outside the session&#x27;s folder|outside the session’s folder/)
  assert.match(outside, /may ask for permission/)
})

test('Resolve with Copilot is disabled, with the reason, when no session here can do it', () => {
  assert.equal(resolveBlocker({ title: 'A' }, false), null)
  assert.match(resolveBlocker(null, false) ?? '', /Open a session in this window/)
  assert.match(resolveBlocker({ title: 'A', taskBlocker: 'This session is read-only, so it cannot edit files or run Git.' }, false) ?? '', /read-only/)
  assert.match(resolveBlocker({ title: 'A' }, true) ?? '', /running Git operation/)
  assert.match(resolveBlocker({ title: 'A' }, false, true) ?? '', /Handing the task to “A”/, 'a second click waits for the first request')
  const blocked = resolveBar({ blocker: 'This session is read-only, so it cannot edit files or run Git.' })
  assert.match(blocked, /<button[^>]*disabled[^>]*>Resolve with Copilot/)
  assert.match(blocked, /git-note">This session is read-only/)
})

test('a repository inside the session\'s folder is told apart from one outside it, as Windows compares paths', () => {
  assert.equal(folderWithin('D:\\one', 'd:/one/'), true)
  assert.equal(folderWithin('D:\\one\\beta', 'D:\\one'), true)
  assert.equal(folderWithin('D:\\one', 'D:\\one.worktrees\\desktop-x'), false, 'the main worktree is outside a worktree session')
  assert.equal(folderWithin('D:\\one-two', 'D:\\one'), false)
  assert.equal(folderWithin('D:\\one', ''), false)
})

test('Commit waits, and says why, while Copilot works on the repository', () => {
  const locked = commitBox({ lockedReason: 'Copilot is working on this repository in “Fix login”. Wait for it to finish.' })
  assert.match(locked, /<button[^>]*disabled[^>]*>Commit 2 files/)
  assert.match(locked, /Copilot is working on this repository/)
})
