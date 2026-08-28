import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeOsc52ClipboardWrite, stripOsc52Commands } from '../renderer/osc52-clipboard.js'

test('decodes a Copilot OSC 52 system clipboard write as UTF-8', () => {
  const encoded = Buffer.from('copied 界', 'utf8').toString('base64')
  assert.equal(decodeOsc52ClipboardWrite(`c;${encoded}`), 'copied 界')
})

test('accepts unpadded base64 and the default clipboard selection', () => {
  assert.equal(decodeOsc52ClipboardWrite(';dGVzdA'), 'test')
})

test('rejects clipboard reads, other selections, invalid UTF-8, and oversized writes', () => {
  assert.equal(decodeOsc52ClipboardWrite('c;?'), null)
  assert.equal(decodeOsc52ClipboardWrite('p;dGVzdA=='), null)
  assert.equal(decodeOsc52ClipboardWrite('c;//8='), null)
  assert.equal(decodeOsc52ClipboardWrite(`c;${'A'.repeat(1_333_337)}`), null)
})

test('removes historical OSC 52 writes from BEL- and ST-terminated backlog text', () => {
  assert.equal(
    stripOsc52Commands(`before\u001b]52;c;dGVzdA==\u0007middle\u001b]52;c;bW9yZQ==\u001b\\after`),
    'beforemiddleafter',
  )
  assert.equal(stripOsc52Commands('ordinary terminal output'), 'ordinary terminal output')
})
