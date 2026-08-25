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

test('buildPermissionArgs: read-only exposes only explicit read and interaction tools', () => {
  assert.deepEqual(
    buildPermissionArgs('read-only', 'C:\\work\\project'),
    ['--available-tools=view,glob,grep,ask_user'],
  )
})

test('buildPermissionArgs: read-only falls back to legacy deny flags without allowlist support', () => {
  assert.deepEqual(
    buildPermissionArgs('read-only', 'C:\\work\\project', { toolAllowlist: false }),
    ['--deny-tool=write', '--deny-tool=shell'],
  )
})

test('buildPermissionArgs: full-auto adds --allow-all-tools', () => {
  assert.deepEqual(buildPermissionArgs('full-auto', 'C:\\work\\project'), ['--allow-all-tools'])
})

test('buildPermissionArgs: full-access disables tool, path, and URL verification', () => {
  assert.deepEqual(buildPermissionArgs('full-access', 'C:\\work\\project'), ['--allow-all'])
})

test('isPermissionPreset narrows valid preset strings and rejects everything else', () => {
  assert.equal(isPermissionPreset('default'), true)
  assert.equal(isPermissionPreset('read-only'), true)
  assert.equal(isPermissionPreset('trusted-directory'), true)
  assert.equal(isPermissionPreset('full-auto'), true)
  assert.equal(isPermissionPreset('full-access'), true)
  assert.equal(isPermissionPreset('danger-full-access'), false)
  assert.equal(isPermissionPreset(42), false)
  assert.equal(isPermissionPreset(null), false)
})
