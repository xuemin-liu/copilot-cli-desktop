import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildPermissionArgs,
  isPermissionPreset,
  needsToolAllowlistProbe,
  permissionCompatibilityWarning,
} from './permission-presets.js'

const MODERN_CAPABILITIES = { toolAllowlist: true }
const LEGACY_CAPABILITIES = { toolAllowlist: false }

test('buildPermissionArgs: default prompts for everything and adds no flags', () => {
  assert.deepEqual(buildPermissionArgs('default', 'C:\\work\\project', MODERN_CAPABILITIES), [])
})

test('buildPermissionArgs: trusted-directory adds --add-dir with the workspace path', () => {
  assert.deepEqual(
    buildPermissionArgs('trusted-directory', 'C:\\work\\project', MODERN_CAPABILITIES),
    ['--add-dir', 'C:\\work\\project'],
  )
})

test('buildPermissionArgs: read-only exposes only explicit read and interaction tools', () => {
  assert.deepEqual(
    buildPermissionArgs('read-only', 'C:\\work\\project', MODERN_CAPABILITIES),
    ['--available-tools=view,glob,grep,ask_user'],
  )
})

test('buildPermissionArgs: read-only falls back to legacy deny flags without allowlist support', () => {
  assert.deepEqual(
    buildPermissionArgs('read-only', 'C:\\work\\project', LEGACY_CAPABILITIES),
    ['--deny-tool=write', '--deny-tool=shell'],
  )
})

test('buildPermissionArgs: full-auto adds --allow-all-tools', () => {
  assert.deepEqual(buildPermissionArgs('full-auto', 'C:\\work\\project', MODERN_CAPABILITIES), ['--allow-all-tools'])
})

test('buildPermissionArgs: full-access disables tool, path, and URL verification', () => {
  assert.deepEqual(buildPermissionArgs('full-access', 'C:\\work\\project', MODERN_CAPABILITIES), ['--allow-all'])
})

test('legacy restricted mode explains its weaker compatibility guarantee', () => {
  assert.match(permissionCompatibilityWarning('read-only', LEGACY_CAPABILITIES) ?? '', /Only shell and write tools are denied/)
  assert.equal(permissionCompatibilityWarning('read-only', MODERN_CAPABILITIES), null)
  assert.equal(permissionCompatibilityWarning('default', LEGACY_CAPABILITIES), null)
})

test('only restricted mode needs a tool-allowlist capability probe', () => {
  assert.equal(needsToolAllowlistProbe('read-only'), true)
  for (const preset of ['default', 'trusted-directory', 'full-auto', 'full-access'] as const) {
    assert.equal(needsToolAllowlistProbe(preset), false)
  }
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
