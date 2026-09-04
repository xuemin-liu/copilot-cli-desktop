import assert from 'node:assert/strict'
import test from 'node:test'
import { isSessionPermissionMode, parsePermissionChangedEvent } from './permission-modes.js'

test('permission mode parser accepts only structured Copilot permission events', () => {
  assert.equal(parsePermissionChangedEvent('{"type":"session.permissions_changed","data":{"mode":"manual"}}'), 'manual')
  assert.equal(parsePermissionChangedEvent('{"type":"session.permissions_changed","data":{"mode":"assisted"}}'), 'assisted')
  assert.equal(parsePermissionChangedEvent('{"type":"session.permissions_changed","data":{"mode":"allow-all"}}'), 'allow-all')
  assert.equal(parsePermissionChangedEvent('{"type":"assistant.message","data":{"content":"All permissions are now enabled."}}'), null)
  assert.equal(parsePermissionChangedEvent('{"type":"session.permissions_changed","data":{"mode":"invalid"}}'), null)
  assert.equal(parsePermissionChangedEvent('not json'), null)
  assert.equal(isSessionPermissionMode('allow-all'), true)
  assert.equal(isSessionPermissionMode('default'), false)
})
