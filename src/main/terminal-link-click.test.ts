import assert from 'node:assert/strict'
import test from 'node:test'
import { LinkClickGate } from '../renderer/terminal-link-click.js'

const press = '\u001b[<0;12;53M', release = '\u001b[<0;12;53m', hoverMove = '\u001b[<35;12;53M', drag = '\u001b[<32;14;53M'

/** A gate with the pointer on a link and the left button just pressed. */
function clicked(shift = false): LinkClickGate {
  const gate = new LinkClickGate()
  gate.hover(true)
  gate.press(0, shift)
  return gate
}

test('a click on a link is not reported to the CLI', () => {
  const gate = clicked()
  assert.deepEqual(gate.filter(hoverMove), [hoverMove], 'pointer motion before the press is not part of the click')
  assert.deepEqual(gate.filter(press), [])
  assert.deepEqual(gate.filter(release), [])
  assert.deepEqual(gate.filter('typed'), ['typed'])
  // The next click, away from the link, is the CLI's again.
  gate.hover(false); gate.press(0, false)
  assert.deepEqual([...gate.filter(press), ...gate.filter(release)], [press, release])
})

test('Ctrl+click on a link, which reveals the file, is not reported either', () => {
  const gate = clicked()
  assert.deepEqual([...gate.filter('\u001b[<16;12;53M'), ...gate.filter('\u001b[<16;12;53m')], [])
})

test('a drag that starts on a link is the CLI\'s text selection: the press is sent after all, in order', () => {
  const gate = clicked()
  assert.deepEqual(gate.filter(press), [])
  assert.deepEqual(gate.filter(drag), [press, drag])
  assert.deepEqual(gate.filter(drag), [drag])
  assert.deepEqual(gate.filter(release), [release])
})

test('nothing is held back away from a link, for another button, with Shift, or for the wheel', () => {
  const away = new LinkClickGate(); away.press(0, false)
  assert.deepEqual([...away.filter(press), ...away.filter(release)], [press, release])
  const right = new LinkClickGate(); right.hover(true); right.press(2, false)
  assert.deepEqual(right.filter('\u001b[<2;12;53M'), ['\u001b[<2;12;53M'])
  assert.deepEqual(clicked(true).filter(press), [press])
  const wheel = clicked()
  assert.deepEqual(wheel.filter('\u001b[<64;12;53M'), ['\u001b[<64;12;53M'], 'a wheel report has the left button bits clear but is not a press')
})

test('ordinary input passes at once while a press is held, and a reset forgets an unfinished gesture', () => {
  const gate = clicked()
  gate.filter(press)
  assert.deepEqual(gate.filter('\r'), ['\r'], 'ordinary input is never delayed')
  const lost = clicked()
  lost.filter(press); lost.reset()
  assert.deepEqual(lost.filter(release), [release])
})
