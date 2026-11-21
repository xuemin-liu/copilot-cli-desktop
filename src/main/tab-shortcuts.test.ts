import assert from 'node:assert/strict'
import test from 'node:test'
import { tabShortcutOwner } from '../renderer/tab-shortcuts.js'

/** An element that sits inside the given ancestors, for a helper that only asks `closest`. */
const inside = (...selectors: string[]): { closest(selector: string): unknown } => ({ closest: selector => selectors.includes(selector) ? {} : null })

test('Ctrl/Cmd+W and +T belong to the tools when pressed anywhere inside them, text fields included', () => {
  assert.equal(tabShortcutOwner(inside('.workspace-tools')), 'tools')
  assert.equal(tabShortcutOwner(inside('.workspace-tools', '.tool-terminal-panel')), 'terminal', 'a tool terminal keeps the key for its shell')
})

test('everything outside the tools, and a target that is not an element, belongs to the session', () => {
  assert.equal(tabShortcutOwner(inside()), 'session')
  assert.equal(tabShortcutOwner(inside('.tool-terminal-panel')), 'session')
  for (const target of [null, undefined, {}, 'body']) assert.equal(tabShortcutOwner(target), 'session')
})
