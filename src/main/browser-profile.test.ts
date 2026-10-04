import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { browserProfilePaths, normalizeBrowserProfileId, selectBrowserProfileId } from './browser-profile.js'

const FIRST = '11111111-1111-4111-8111-111111111111'
test('restored browser profiles remain stable and never share an active terminal profile', () => {
  assert.equal(selectBrowserProfileId(FIRST, []), FIRST)
  const duplicate = selectBrowserProfileId(FIRST, [FIRST])
  assert.notEqual(duplicate, FIRST)
  assert.equal(normalizeBrowserProfileId(duplicate), duplicate)
  const fresh = selectBrowserProfileId(undefined, [FIRST, duplicate])
  assert.ok(fresh !== FIRST && fresh !== duplicate)
  assert.equal(selectBrowserProfileId(fresh, []), fresh)
  assert.deepEqual(browserProfilePaths('user-data', FIRST), {
    settings: join('user-data', 'browser-profiles', FIRST, 'settings.json'),
    partition: `persist:browser-debug:${FIRST}`,
  })
  for (const invalid of ['../tab-1', '', 'tab-1', null]) {
    assert.equal(normalizeBrowserProfileId(invalid), undefined)
    assert.throws(() => browserProfilePaths('user-data', invalid as string), /Invalid browser profile/)
  }
})
