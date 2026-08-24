import assert from 'node:assert/strict'
import test from 'node:test'
import { parseWindowsElevation } from './access-status.js'

test('parseWindowsElevation recognizes standard and elevated integrity groups', () => {
  assert.equal(parseWindowsElevation('Mandatory Label\\Medium Mandatory Level,S-1-16-8192'), 'standard-user')
  assert.equal(parseWindowsElevation('Mandatory Label\\High Mandatory Level,S-1-16-12288'), 'administrator')
  assert.equal(parseWindowsElevation('unrecognized output'), 'unknown')
})
