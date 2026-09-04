import assert from 'node:assert/strict'
import test from 'node:test'
import { describeSessionPermission, isSessionPermissionMode, parsePermissionChangedEvent } from './permission-modes.js'

test('permission mode parser accepts only structured Copilot permission events', () => {
  assert.equal(parsePermissionChangedEvent('{"type":"session.permissions_changed","data":{"mode":"manual"}}'), 'manual')
  assert.equal(parsePermissionChangedEvent('{"type":"session.permissions_changed","data":{"mode":"assisted"}}'), 'assisted')
  assert.equal(parsePermissionChangedEvent('{"type":"session.permissions_changed","data":{"mode":"allow-all"}}'), 'allow-all')
  assert.equal(parsePermissionChangedEvent('{"type":"session.permissions_changed","data":{"previousAllowAllPermissions":false,"allowAllPermissions":false,"previousAllowAllPermissionMode":"off","allowAllPermissionMode":"auto"}}'), 'assisted')
  assert.equal(parsePermissionChangedEvent('{"type":"session.permissions_changed","data":{"previousAllowAllPermissionMode":"auto","allowAllPermissionMode":"off"}}'), 'manual')
  assert.equal(parsePermissionChangedEvent('{"type":"session.permissions_changed","data":{"allowAllPermissionMode":"on"}}'), 'allow-all')
  assert.equal(parsePermissionChangedEvent('{"type":"session.permissions_changed","data":{"allowAllPermissions":true}}'), 'allow-all')
  assert.equal(parsePermissionChangedEvent('{"type":"session.permissions_changed","data":{"allowAllPermissions":false}}'), 'manual')
  assert.equal(parsePermissionChangedEvent('{"type":"assistant.message","data":{"content":"All permissions are now enabled."}}'), null)
  assert.equal(parsePermissionChangedEvent('{"type":"session.permissions_changed","data":{"mode":"invalid"}}'), null)
  assert.equal(parsePermissionChangedEvent('not json'), null)
  assert.equal(isSessionPermissionMode('allow-all'), true)
  assert.equal(isSessionPermissionMode('default'), false)
})

test('permission mode parser reports unknown permission payloads only', () => {
  const unknown: unknown[] = []
  assert.equal(parsePermissionChangedEvent(
    '{"type":"session.permissions_changed","data":{"futureMode":"maybe"}}',
    (payload) => unknown.push(payload),
  ), null)
  assert.equal(parsePermissionChangedEvent(
    '{"type":"assistant.message","data":{"futureMode":"maybe"}}',
    (payload) => unknown.push(payload),
  ), null)
  assert.deepEqual(unknown, [{ futureMode: 'maybe' }])
})

test('permission description keeps restriction tone while including runtime mode', () => {
  assert.deepEqual(describeSessionPermission('read-only', 'manual'), {
    label: 'Restricted tools · Manual approval',
    tone: 'read-only',
  })
  assert.deepEqual(describeSessionPermission('trusted-directory', 'assisted'), {
    label: 'Trusted directory · Assisted approval',
    tone: 'trusted-directory',
  })
  assert.deepEqual(describeSessionPermission('default', 'manual'), {
    label: 'Manual approval',
    tone: 'manual',
  })
})
