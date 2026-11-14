import assert from 'node:assert/strict'
import test from 'node:test'
import { dockLayout } from '../renderer/components/ProjectDock.js'
import { readToolDockPreferences, terminalLayout, TOOL_DOCK_KEY } from '../renderer/tool-dock-state.js'

test('dock takeover accounts for both terminals and the left sidebar', () => {
  for (const sidebar of [280, 64]) {
    for (const two of [false, true]) {
      const threshold = sidebar + (two ? 966 : 480) + 6 + 320
      assert.equal(threshold, two ? sidebar === 280 ? 1572 : 1356 : sidebar === 280 ? 1086 : 870)
      assert.equal(dockLayout(threshold - sidebar, 420, two).takeover, false)
      assert.equal(dockLayout(threshold - sidebar - 1, 420, two).takeover, true)
    }
  }
})

test('each split terminal retains 480 pixels, with preferred ratio restored when space returns', () => {
  assert.equal(terminalLayout(965, true, 25).single, true)
  assert.deepEqual(terminalLayout(966, true, 25), { single: false, split: 50 })
  for (const available of [966, 1000, 1400, 2000]) {
    for (const ratio of [25, 55, 75]) {
      const layout = terminalLayout(available, true, ratio)
      assert.ok((available - 6) * layout.split / 100 >= 480 - 1e-8)
      assert.ok((available - 6) * (100 - layout.split) / 100 >= 480 - 1e-8)
    }
  }
  assert.equal(terminalLayout(2000, true, 25).split, 25)
  assert.equal(terminalLayout(700, false, 55).single, false)
})

test('dock preferences migrate legacy Git settings without overwriting current preferences', () => {
  const map = new Map<string, string>()
  const storage = { getItem: (key: string) => map.get(key) ?? null }
  assert.deepEqual(readToolDockPreferences(storage), { open: false, width: 420, tool: 'browser' })
  map.set('git-panel-open', 'true'); map.set('git-panel-width', '680')
  assert.deepEqual(readToolDockPreferences(storage), { open: true, width: 680, tool: 'git' })
  map.set(TOOL_DOCK_KEY, JSON.stringify({ open: false, width: 500, tool: 'browser' }))
  assert.deepEqual(readToolDockPreferences(storage), { open: false, width: 500, tool: 'browser' })
  assert.equal(map.get('git-panel-open'), 'true', 'migration leaves legacy preferences intact')
  for (const width of [1, 99999, null, '520']) {
    map.set(TOOL_DOCK_KEY, JSON.stringify({ open: 'true', width, tool: 'unknown' }))
    const prefs = readToolDockPreferences(storage)
    assert.equal(prefs.open, false); assert.equal(prefs.tool, 'browser')
    assert.ok(prefs.width >= 320 && prefs.width <= 2400)
  }
  map.set(TOOL_DOCK_KEY, '{bad JSON')
  assert.equal(readToolDockPreferences(storage).open, false, 'invalid new preferences do not revive legacy open state')
})
