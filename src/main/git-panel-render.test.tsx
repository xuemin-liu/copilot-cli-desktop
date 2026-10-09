import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { GitDiffView, diffLineKind } from '../renderer/components/GitDiffView.js'
import { GitPanel } from '../renderer/components/GitPanel.js'
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
