import assert from 'node:assert/strict'
import test from 'node:test'
import { errorMessage } from '../renderer/errors.js'

test('IPC errors omit Electron transport details from user-facing messages', () => {
  assert.equal(errorMessage(new Error("Error invoking remote method 'desktop:reveal-path': Error: Cannot reveal this file")), 'Cannot reveal this file')
  assert.equal(errorMessage("Error invoking remote method 'desktop:open-external-url': Browser unavailable"), 'Browser unavailable')
  assert.equal(errorMessage(new Error('Permission denied')), 'Permission denied')
  assert.equal(errorMessage('Something failed'), 'Something failed')
})
