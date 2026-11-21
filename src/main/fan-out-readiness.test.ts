import assert from 'node:assert/strict'
import test from 'node:test'
import { fanOutReadiness } from './fan-out-readiness.js'

test('a fan-out session is ready once its prompt is drawn, and a separate window or a closed tab is told apart', () => {
  assert.equal(fanOutReadiness(null), 'gone')
  assert.equal(fanOutReadiness({ poppedOut: false, recentOutput: '' }), 'waiting')
  assert.equal(fanOutReadiness({ poppedOut: false, recentOutput: 'Loading…\r\n' }), 'waiting')
  assert.equal(fanOutReadiness({ poppedOut: false, recentOutput: '\u001b[?2004h> \r\n <- open sidebar | / commands\r\n' }), 'ready')
  // Its own window owns the terminal, drawn or not.
  assert.equal(fanOutReadiness({ poppedOut: true, recentOutput: ' <- open sidebar' }), 'elsewhere')
  assert.equal(fanOutReadiness({ poppedOut: true, recentOutput: '' }), 'elsewhere')
})
