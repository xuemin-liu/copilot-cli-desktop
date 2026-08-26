import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('terminal wheel invalidation is registered in capture phase', async () => {
  const source = await readFile('src/renderer/components/TerminalPane.tsx', 'utf8')
  assert.match(
    source,
    /addEventListener\('wheel', handleWheelDuringSelection, \{ capture: true, passive: true \}\)/,
    'xterm stops application-mouse wheel events at its child element, so a bubbling parent listener never runs',
  )
  assert.match(
    source,
    /removeEventListener\('wheel', handleWheelDuringSelection, true\)/,
    'the capture listener must be removed with the same capture flag',
  )
})

test('detached selections do not consume Ctrl+C and paste still clears selection', async () => {
  const source = await readFile('src/renderer/components/TerminalPane.tsx', 'utf8')
  assert.match(
    source,
    /retainedSelectionPhase === 'active' \? retainedSelection : ''/,
    'only an active retained selection should be exposed to copy actions',
  )
  assert.match(
    source,
    /if \(!copied && retainedSelectionRange\) clearRetainedSelection\(\)/,
    'Ctrl+C should clear a detached snapshot and continue to the terminal',
  )
  assert.match(
    source,
    /clearRetainedSelection\(\)[\s\S]*?readClipboardText\(\)[\s\S]*?terminal\.paste\(text\)/,
    'paste should clear selection state and use xterm paste for bracketed-paste handling',
  )
})
