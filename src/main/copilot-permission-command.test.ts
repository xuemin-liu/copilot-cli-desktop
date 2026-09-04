import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CopilotPermissionCommandTracker,
  nativeModeForPermissionPreset,
  permissionConfirmationMarker,
  permissionModeFromCommand,
  permissionPresetForMode,
} from './copilot-permission-command.js'

test('permission command parser accepts native direct commands and aliases', () => {
  assert.equal(permissionModeFromCommand('/permissions default'), 'default')
  assert.equal(permissionModeFromCommand(' /PERMISSIONS   assisted '), 'assisted')
  assert.equal(permissionModeFromCommand('/permissions allow-all'), 'allow-all')
  assert.equal(permissionModeFromCommand('/allow-all'), 'allow-all')
  assert.equal(permissionModeFromCommand('/yolo'), 'allow-all')
  assert.equal(permissionModeFromCommand('/permissions show'), null)
  assert.equal(permissionModeFromCommand('/permissions'), null)
  assert.equal(permissionModeFromCommand('explain /permissions allow-all'), null)
})

test('permission command tracker handles character input, edits, and pasted commands', () => {
  const tracker = new CopilotPermissionCommandTracker()
  for (const char of '/permissions assistex') assert.deepEqual(tracker.accept(char), [])
  assert.deepEqual(tracker.accept('\x7fd\r'), ['assisted'])
  assert.deepEqual(tracker.accept('\x1b[200~/permissions allow-all\x1b[201~\r'), ['allow-all'])
  assert.deepEqual(tracker.accept('/permissions show\r'), [])
})

test('native modes map to durable session permission presets', () => {
  assert.equal(permissionPresetForMode('default'), 'default')
  assert.equal(permissionPresetForMode('assisted'), 'assisted')
  assert.equal(permissionPresetForMode('allow-all'), 'full-access')
  assert.equal(nativeModeForPermissionPreset('full-access'), 'allow-all')
  assert.equal(nativeModeForPermissionPreset('read-only'), null)
  assert.equal(nativeModeForPermissionPreset(null), null)
  assert.equal(permissionConfirmationMarker('default'), 'All permissions have been disabled.')
})
