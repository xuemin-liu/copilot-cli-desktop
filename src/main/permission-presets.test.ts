import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPermissionArgs, isPermissionPreset } from './permission-presets.js'

test('buildPermissionArgs: default prompts for everything and adds no flags', () => {
  assert.deepEqual(buildPermissionArgs('default', 'C:\\work\\project'), [])
})

test('buildPermissionArgs: trusted-directory adds --add-dir with the workspace path', () => {
  assert.deepEqual(
    buildPermissionArgs('trusted-directory', 'C:\\work\\project'),
    ['--add-dir', 'C:\\work\\project'],
  )
})

test('buildPermissionArgs: full-auto adds --allow-all-tools', () => {
  assert.deepEqual(buildPermissionArgs('full-auto', 'C:\\work\\project'), ['--allow-all-tools'])
})

test('isPermissionPreset narrows valid preset strings and rejects everything else', () => {
  assert.equal(isPermissionPreset('default'), true)
  assert.equal(isPermissionPreset('trusted-directory'), true)
  assert.equal(isPermissionPreset('full-auto'), true)
  assert.equal(isPermissionPreset('danger-full-access'), false)
  assert.equal(isPermissionPreset(42), false)
  assert.equal(isPermissionPreset(null), false)
})
