import assert from 'node:assert/strict'
import test from 'node:test'
import { embeddedTerminalEnvironment } from './node-pty-backend.js'

test('interactive PTYs advertise the embedded xterm even when the launcher has TERM=dumb', () => {
  const inherited = { TERM: 'dumb', COLORTERM: '', KEEP_ME: 'value' }

  const result = embeddedTerminalEnvironment(inherited)

  assert.deepEqual(result, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    KEEP_ME: 'value',
  })
  assert.equal(inherited.TERM, 'dumb')
})
