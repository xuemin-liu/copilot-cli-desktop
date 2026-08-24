import assert from 'node:assert/strict'
import test from 'node:test'
import { isLauncherShellUrl } from './renderer-trust.js'

const shellUrl = 'file:///app/renderer/index.html'

test('isLauncherShellUrl accepts only the exact local renderer surface', () => {
  assert.equal(isLauncherShellUrl(shellUrl, shellUrl), true)
  assert.equal(isLauncherShellUrl('file:///app/renderer/settings.html', shellUrl), false)
  assert.equal(isLauncherShellUrl('https://example.com/', shellUrl), false)
  assert.equal(isLauncherShellUrl('not-a-url', shellUrl), false)
  assert.equal(isLauncherShellUrl(null, shellUrl), false)
  assert.equal(isLauncherShellUrl(undefined, shellUrl), false)
})
