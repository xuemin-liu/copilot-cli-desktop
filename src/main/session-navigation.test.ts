import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionNavigation } from './session-navigation.js'
import { activateTab, createTab, EMPTY_TABS_STATE, type NewTabInput, type TabsState } from './session-tab-machine.js'

function addTab(state: TabsState, id: string, sideChat?: Pick<NewTabInput, 'sideChat' | 'sideParentTabId'>): TabsState {
  return createTab(state, {
    id, title: id, workspaceProfileId: 'project', cliVersion: null,
    sessionPermissionPreset: null, permissionWarning: null, remote: false, ...sideChat,
  })
}

const tabs = addTab(addTab(addTab(EMPTY_TABS_STATE, 'a'), 'b'), 'c')
const open = new Set(tabs.tabs.map(tab => tab.id))

function history(visits: string[]): SessionNavigation {
  const navigation = new SessionNavigation()
  for (const id of visits) navigation.record(activateTab(tabs, id))
  return navigation
}

test('Back and Forward follow repeat visits, while repeated focus creates a single entry', () => {
  const navigation = history(['a', 'a', 'b', 'a'])
  assert.equal(navigation.canMove('back', open), true)
  assert.equal(navigation.canMove('forward', open), false)
  assert.equal(navigation.move('back', open), 'b')
  navigation.record(activateTab(tabs, 'b'))
  assert.equal(navigation.move('back', open), 'a')
  assert.equal(navigation.move('back', open), null)
  assert.equal(navigation.move('forward', open), 'b')
  assert.equal(navigation.move('forward', open), 'a')
  assert.equal(navigation.move('forward', open), null)
})

test('selecting a different session after Back discards forward history', () => {
  const navigation = history(['a', 'b', 'c'])
  assert.equal(navigation.move('back', open), 'b')
  navigation.record(activateTab(tabs, 'a'))
  assert.equal(navigation.move('forward', open), null)
  assert.equal(navigation.move('back', open), 'b')
})

test('navigation skips unavailable sessions and repeated entries for the current session', () => {
  const navigation = history(['a', 'b', 'a', 'c'])
  const available = new Set(['a', 'c'])
  assert.equal(navigation.move('back', available), 'a')
  assert.equal(navigation.move('back', available), null)
  assert.equal(navigation.move('forward', available), 'c')

  const withoutMiddle = history(['a', 'b', 'c'])
  assert.equal(withoutMiddle.move('back', available), 'a')
  assert.equal(withoutMiddle.move('forward', available), 'c')
})

test('navigation retains the most recent 100 visits', () => {
  const recent = Array.from({ length: 100 }, (_, index) => index % 2 === 0 ? 'b' : 'c')
  const navigation = history(['a', ...recent])
  for (const id of recent.slice(0, -1).reverse()) assert.equal(navigation.move('back', open), id)
  assert.equal(navigation.move('back', open), null)
})

test('moving focus between a session and its side chat keeps one history entry', () => {
  const withSide = addTab(tabs, 'side', { sideChat: true, sideParentTabId: 'a' })
  const available = new Set([...open, 'side'])
  const navigation = new SessionNavigation()
  for (const id of ['a', 'side', 'a', 'side', 'b']) navigation.record(activateTab(withSide, id))
  assert.equal(navigation.move('back', available), 'a')
  navigation.record(activateTab(withSide, 'side'))
  assert.equal(navigation.canMove('back', available), false)
  assert.equal(navigation.move('forward', available), 'b')
  assert.equal(navigation.canMove('forward', available), false)
})
