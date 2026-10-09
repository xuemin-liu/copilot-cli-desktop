import assert from 'node:assert/strict'
import test from 'node:test'
import { appendOutput, readableOutput, stripTerminalEscapes } from './git-output.js'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const CR = String.fromCharCode(13)

test('colour and cursor codes are removed, the words stay', () => {
  assert.equal(stripTerminalEscapes(`${ESC}[31merror${ESC}[0m: bad ${ESC}[1;32mthing${ESC}[0m`), 'error: bad thing')
  assert.equal(stripTerminalEscapes(`${ESC}[2K${ESC}[1Gprogress`), 'progress')
  assert.equal(stripTerminalEscapes('plain text, 100% fine [1;2m'), 'plain text, 100% fine [1;2m', 'brackets without an escape are text')
})

test('window-title and link sequences are removed, ended by BEL or ESC backslash', () => {
  assert.equal(stripTerminalEscapes(`${ESC}]0;my title${BEL}after`), 'after')
  assert.equal(stripTerminalEscapes(`a${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\b`), 'alinkb')
})

test('a stray escape character is dropped and carriage returns become newlines', () => {
  assert.equal(stripTerminalEscapes(`a${ESC}b`), 'ab')
  assert.equal(readableOutput(`one${CR}\ntwo${CR}three`), 'one\ntwo\nthree')
})

test('a transcript keeps only its tail', () => {
  let text = ''
  for (let index = 0; index < 100; index++) text = appendOutput(text, `line ${index} ${'x'.repeat(50)}\n`, 500)
  assert.equal(text.length, 500)
  assert.match(text, /line 99 /)
  assert.doesNotMatch(text, /line 0 /)
  assert.equal(appendOutput('abc', `${ESC}[31mdef${ESC}[0m`), 'abcdef')
})
