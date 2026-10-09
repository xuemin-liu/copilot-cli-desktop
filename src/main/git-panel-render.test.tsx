import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { GitDiffView, diffLineKind } from '../renderer/components/GitDiffView.js'
import { GitPanel } from '../renderer/components/GitPanel.js'
import { GitCommitBox, commitBlocker } from '../renderer/components/GitCommitBox.js'
import { GitReviewCard } from '../renderer/components/GitReviewCard.js'
import { GIT_PANEL_MIN_WIDTH, ProjectDock, SESSION_MIN_WIDTH, dockLayout } from '../renderer/components/ProjectDock.js'
import type { GitDiffView as GitDiff } from './git-types.js'

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
    onDraft={() => undefined} onCommit={() => undefined} onCancel={() => undefined} hooks={null} onApproveHooks={() => undefined} onDismissHooks={() => undefined} {...overrides} />)

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
