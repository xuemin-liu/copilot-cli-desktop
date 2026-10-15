import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { overridesFromDevtools, overridesFromPreferences } from './browser-overrides.js'
import { overridesStatus } from './browser-overrides-status.js'

const folder = join(process.cwd(), 'overrides-folder')

test('the running DevTools reports the toggle and the overrides folder as a local path', () => {
  assert.deepEqual(overridesFromDevtools({ enabled: true, folders: [pathToFileURL(folder).href] }), { enabled: true, folder })
  assert.deepEqual(overridesFromDevtools({ enabled: false, folders: [] }), { enabled: false, folder: null })
  // DevTools was not ready to answer, or answered something unexpected.
  assert.equal(overridesFromDevtools(null), null)
  assert.equal(overridesFromDevtools({ enabled: 'true', folders: [] }), null)
  assert.equal(overridesFromDevtools({ enabled: true }), null)
})

test('saved preferences give the partition toggle and only the folder added for overrides', () => {
  const partition = { electron: { devtools: { preferences: { 'persistence-network-overrides-enabled': 'true' } } } }
  const defaults = { devtools: { file_system_paths: { 'D:\\workspace': '', [folder]: 'overrides' } } }
  assert.deepEqual(overridesFromPreferences(partition, defaults), { enabled: true, folder })
  assert.deepEqual(overridesFromPreferences(partition, { devtools: { file_system_paths: { 'D:\\workspace': '' } } }), { enabled: true, folder: null })
  const off = { electron: { devtools: { preferences: { 'persistence-network-overrides-enabled': 'false' } } } }
  assert.deepEqual(overridesFromPreferences(off, defaults), { enabled: false, folder })
  // Nothing saved yet, or files that are not what Chromium writes.
  assert.deepEqual(overridesFromPreferences(undefined, undefined), { enabled: false, folder: null })
  assert.deepEqual(overridesFromPreferences([], 'x'), { enabled: false, folder: null })
})

test('the footer says whether overrides apply to this page, and why not', () => {
  assert.deepEqual(overridesStatus({ enabled: true, folder, devtools: true }), { tone: 'on', text: `Local Overrides: on · ${folder}` })
  const closed = overridesStatus({ enabled: true, folder, devtools: false })
  assert.equal(closed.tone, 'warning')
  assert.match(closed.text, /not applied to this page until its DevTools opens/)
  assert.ok(closed.text.endsWith(folder))
  assert.deepEqual(overridesStatus({ enabled: true, folder: null, devtools: true }), { tone: 'warning', text: 'Local Overrides: on, but no overrides folder is selected' })
  assert.deepEqual(overridesStatus({ enabled: false, folder, devtools: true }), { tone: 'off', text: 'Local Overrides: off' })
  assert.equal(overridesStatus(undefined).tone, 'off')
})
