import assert from 'node:assert/strict'
import test from 'node:test'
import { ClipboardWriteGate, decodeOsc52ClipboardWrite, stripOsc52Commands } from '../renderer/osc52-clipboard.js'

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

test('removes a truncated unterminated OSC 52 write from the end of a backlog', () => {
  assert.equal(stripOsc52Commands('before\u001b]52;c;dGVzdA…[truncated]'), 'before')
  assert.equal(
    stripOsc52Commands('before\u001b]52;c;dGVzdA…[truncated]\n\u001b[Hafter'),
    'before\u001b[Hafter',
  )
})

test('clipboard writes require and consume a recent local copy gesture', () => {
  let now = 100
  const gate = new ClipboardWriteGate(() => now, 50)
  assert.equal(gate.consumeDecodedWrite('text'), false)
  gate.authorize()
  assert.equal(gate.consumeDecodedWrite(null), false)
  assert.equal(gate.consumeDecodedWrite('text'), true)
  assert.equal(gate.consumeDecodedWrite('text'), false)
  gate.authorize()
  now = 151
  assert.equal(gate.consumeDecodedWrite('text'), false)
})
