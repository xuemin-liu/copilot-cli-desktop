import assert from 'node:assert/strict'
import test from 'node:test'
import { contextMenuItems, type ContextMenuInput } from './browser-context-menu.js'

const base: ContextMenuInput = { linkURL: '', srcURL: '', mediaType: 'none', selectionText: '', isEditable: false, editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true } }
const ids = (input: Partial<ContextMenuInput>, navigation = { canGoBack: false, canGoForward: false }): string[] =>
  contextMenuItems({ ...base, ...input }, navigation).map(item => 'separator' in item ? '-' : item.id)

test('a plain page offers navigation, select all and inspect', () => {
  assert.deepEqual(ids({}), ['back', 'forward', 'reload', 'hard-reload', 'select-all', '-', 'inspect'])
  const items = contextMenuItems(base, { canGoBack: true, canGoForward: false })
  assert.deepEqual(items.filter(item => 'id' in item && ['back', 'forward'].includes(item.id)).map(item => 'enabled' in item && item.enabled), [true, false])
})

test('selected text, links, images and editable fields add their own groups', () => {
  assert.deepEqual(ids({ selectionText: 'hello' }).slice(0, 2), ['copy', '-'])
  assert.ok(!ids({ selectionText: 'hello' }).includes('select-all'))
  assert.deepEqual(ids({ linkURL: 'https://example.com/a' }).slice(0, 3), ['open-link', 'copy-link', '-'])
  assert.ok(ids({ mediaType: 'image', srcURL: 'http://localhost/x.png' }).includes('copy-image-address'))
  const editable = ids({ isEditable: true, editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } })
  assert.deepEqual(editable.slice(0, 4), ['cut', 'copy', 'paste', 'select-all'])
})

test('only http(s) links and images can be opened or copied', () => {
  for (const linkURL of ['javascript:alert(1)', 'file:///C:/secret', 'data:text/html,x', 'about:blank', `https://example.com/${'a'.repeat(9000)}`]) {
    assert.ok(!ids({ linkURL }).includes('open-link'), linkURL.slice(0, 30))
  }
  assert.ok(!ids({ mediaType: 'image', srcURL: 'data:image/png;base64,AAAA' }).includes('copy-image-address'))
})
