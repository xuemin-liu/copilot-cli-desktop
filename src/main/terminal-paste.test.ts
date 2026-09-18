import assert from 'node:assert/strict'
import test from 'node:test'
import { handleTerminalPaste, isNativePasteKey, MAX_PASTE_CHARS } from '../renderer/terminal-paste.js'

function paste(text: string, types: string[] = []) {
  const calls: string[] = []
  const event = { clipboardData: { getData: () => text, items: types.map(type => ({ type })) },
    preventDefault: () => calls.push('prevent'), stopImmediatePropagation: () => calls.push('stop') } as unknown as ClipboardEvent
  handleTerminalPaste(event, { input: data => calls.push(data), paste: data => calls.push(data) })
  return calls
}

test('text, including mixed image/text clipboard, stays on the native path', () => {
  assert.deepEqual(paste('hello\nworld', ['text/plain']), [])
  assert.deepEqual(paste('image caption', ['text/plain', 'image/png']), [])
  assert.deepEqual(paste(' '.repeat(MAX_PASTE_CHARS)), [])
})

test('image-only paste invokes the CLI shortcut and empty/unsupported paste sends nothing', () => {
  assert.deepEqual(paste('', ['image/png']), ['prevent', 'stop', '\u001bv'])
  assert.deepEqual(paste(''), ['prevent', 'stop'])
  assert.deepEqual(paste('', ['text/html']), ['prevent', 'stop'])
})

test('oversized text is bounded before xterm frames it, without splitting a surrogate pair', () => {
  const value = 'x'.repeat(MAX_PASTE_CHARS - 1) + '😀tail'
  assert.deepEqual(paste(value), ['prevent', 'stop', 'x'.repeat(MAX_PASTE_CHARS - 1)])
  assert.deepEqual(paste('x'.repeat(MAX_PASTE_CHARS + 1)), ['prevent', 'stop', 'x'.repeat(MAX_PASTE_CHARS)])
})

test('only Ctrl+V keydown is yielded to browser paste, preserving Alt+V and keyup', () => {
  const key = { type: 'keydown', key: 'V', ctrlKey: true, altKey: false, metaKey: false }
  assert.equal(isNativePasteKey(key), true)
  for (const change of [{ type: 'keyup' }, { altKey: true }, { metaKey: true }, { ctrlKey: false }]) {
    assert.equal(isNativePasteKey({ ...key, ...change }), false)
  }
})
