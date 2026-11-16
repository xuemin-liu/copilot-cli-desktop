import assert from 'node:assert/strict'
import test from 'node:test'
import { dockedNeighbor, dockedReorder, panelButtonLabel, removeToolTab, type ProjectTools, type ToolTab } from './tool-tabs.js'

const tab = (id: string, detached = false): ToolTab => ({ id, kind: 'browser', title: id, ...(detached ? { detached } : {}) })
const project = (tabs: ToolTab[], activeId: string | null): ProjectTools =>
  ({ profileId: 'p', browserProfileId: 'b', overrides: 'shared', tabs, activeId, visible: true, width: 420 })

test('a popped-out tab hands the panel to its right neighbour, then its left, skipping windowed tabs', () => {
  const tabs = [tab('a'), tab('b'), tab('c', true), tab('d')]
  assert.equal(dockedNeighbor(tabs, 1, 'b'), 'd')
  assert.equal(dockedNeighbor(tabs, 3, 'd'), 'b')
  assert.equal(dockedNeighbor([tab('a', true), tab('b')], 1, 'b'), null)
  assert.equal(dockedNeighbor([tab('a')], 0, 'a'), null)
})

test('closing the selected tab never selects a tab whose page is in its own window', () => {
  const state = project([tab('a', true), tab('b'), tab('c', true), tab('d')], 'b')
  removeToolTab(state, 'b')
  assert.equal(state.activeId, 'd')
  assert.equal(state.visible, true)
  removeToolTab(state, 'd')
  assert.equal(state.activeId, null)
  assert.equal(state.visible, false, 'closing the last docked tab hides the panel')
})

test('a windowed page closing leaves the panel as it is', () => {
  const blank = project([tab('a', true)], null)
  removeToolTab(blank, 'a')
  assert.equal(blank.visible, true, 'the blank panel stays open')
  assert.equal(panelButtonLabel(blank), 'New tab')
  const docked = project([tab('a', true), tab('b')], 'b')
  removeToolTab(docked, 'a')
  assert.deepEqual([docked.activeId, docked.visible], ['b', true])
})

test('strip reorder indexes count docked tabs only', () => {
  const tabs = [tab('a'), tab('b', true), tab('c'), tab('d')]
  assert.deepEqual(dockedReorder(tabs, 0, 2), { id: 'a', beforeId: 'd' })
  assert.deepEqual(dockedReorder(tabs, 1, 0), { id: 'c', beforeId: 'a' })
  assert.equal(dockedReorder(tabs, 0, 3), null)
})

test('the panel button offers Show tabs while every tab is in its own window', () => {
  assert.equal(panelButtonLabel({ tabs: [tab('a', true)], visible: false }), 'Show tabs')
  assert.equal(panelButtonLabel({ tabs: [], visible: false }), 'New tab')
})
