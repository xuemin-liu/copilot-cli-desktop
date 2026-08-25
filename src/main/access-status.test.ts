import assert from 'node:assert/strict'
import test from 'node:test'
import { parseWindowsElevation, readAccessStatus } from './access-status.js'

test('parseWindowsElevation recognizes standard and elevated integrity groups', () => {
  assert.equal(parseWindowsElevation('Mandatory Label\\Medium Mandatory Level,S-1-16-8192'), 'standard-user')
  assert.equal(parseWindowsElevation('Mandatory Label\\High Mandatory Level,S-1-16-12288'), 'administrator')
  assert.equal(parseWindowsElevation('unrecognized output'), 'unknown')
})

test('configured access status does not reinterpret COPILOT_ALLOW_ALL as --allow-all', async () => {
  const previous = process.env.COPILOT_ALLOW_ALL
  process.env.COPILOT_ALLOW_ALL = 'true'
  try {
    const status = await readAccessStatus('default', { toolAllowlist: true })
    assert.equal(status.permissionPreset, 'default')
    assert.equal(status.permissionSource, 'profile')
  } finally {
    if (previous === undefined) delete process.env.COPILOT_ALLOW_ALL
    else process.env.COPILOT_ALLOW_ALL = previous
  }
})
