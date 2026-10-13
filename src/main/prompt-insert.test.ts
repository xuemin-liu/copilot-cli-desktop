import assert from 'node:assert/strict'
import test from 'node:test'
import { INSERT_PROMPT_EVENT, dispatchPromptInsert, promptInsertText } from '../renderer/prompt-insert.js'

test('a prompt insert is delivered only when a pane for that tab acknowledges it', () => {
  const target = new EventTarget()
  assert.equal(dispatchPromptInsert(target, { tabId: 'tab-1', text: 'hello' }), false, 'no pane: not delivered')
  const seen: unknown[] = []
  target.addEventListener(INSERT_PROMPT_EVENT, (event) => {
    const detail = (event as CustomEvent<{ tabId: string }>).detail
    seen.push(detail)
    if (detail.tabId === 'tab-1') event.preventDefault()
  })
  assert.equal(dispatchPromptInsert(target, { tabId: 'tab-1', text: 'hello' }), true, 'the owning pane took it')
  assert.equal(dispatchPromptInsert(target, { tabId: 'tab-2', text: 'hello' }), false, 'a pane for another tab does not count')
  assert.equal(seen.length, 2, 'both dispatches after the pane appeared reached it; only the matching one acknowledged')
})

test('prompt text is bounded and never carries a bare Enter without bracketed paste', () => {
  assert.equal(promptInsertText('a\r\nb\nc', true), 'a\nb\nc')
  assert.equal(promptInsertText('a\r\nb\nc', false), 'a | b | c')
  assert.equal(promptInsertText('x'.repeat(20_000), true).length, 12_000)
  assert.equal(promptInsertText('tab\there\u0007bell\u001b[31mred', true), 'tab\therebell[31mred', 'control characters other than tab are stripped')
})
