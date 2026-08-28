import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeOsc52ClipboardWrite,
  Osc52ClipboardSynchronizer,
  stripOsc52Commands,
  SYNCHRONIZED_OUTPUT_START,
} from '../renderer/osc52-clipboard.js'

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

test('starts synchronized output before a valid live OSC 52 write in the same xterm chunk', () => {
  let prepareCalls = 0
  const synchronizer = new Osc52ClipboardSynchronizer(() => {
    prepareCalls += 1
    return true
  })
  const command = '\u001b]52;c;dGVzdA==\u0007'

  assert.equal(
    synchronizer.push(`before${command}\u001b[Hcopied to clipboard`),
    `before${SYNCHRONIZED_OUTPUT_START}${command}\u001b[Hcopied to clipboard`,
  )
  assert.equal(prepareCalls, 1)
})

test('reassembles a split OSC 52 write before placing the synchronization marker', () => {
  const synchronizer = new Osc52ClipboardSynchronizer(() => true)

  assert.equal(synchronizer.push('before\u001b]5'), 'before')
  assert.equal(synchronizer.push('2;c;dGVz'), '')
  assert.equal(
    synchronizer.push('dA==\u001b\\after'),
    `${SYNCHRONIZED_OUTPUT_START}\u001b]52;c;dGVzdA==\u001b\\after`,
  )
})

test('does not synchronize OSC 52 reads, invalid writes, or later unclaimed copies', () => {
  let available = true
  const synchronizer = new Osc52ClipboardSynchronizer(() => {
    if (!available) return false
    available = false
    return true
  })

  assert.equal(synchronizer.push('\u001b]52;c;?\u0007'), '\u001b]52;c;?\u0007')
  assert.equal(synchronizer.push('\u001b]52;p;dGVzdA==\u0007'), '\u001b]52;p;dGVzdA==\u0007')
  assert.equal(
    synchronizer.push('\u001b]52;c;dGVzdA==\u0007'),
    `${SYNCHRONIZED_OUTPUT_START}\u001b]52;c;dGVzdA==\u0007`,
  )
  assert.equal(synchronizer.push('\u001b]52;c;bW9yZQ==\u0007'), '\u001b]52;c;bW9yZQ==\u0007')
})
