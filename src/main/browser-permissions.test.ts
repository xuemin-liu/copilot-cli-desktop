import assert from 'node:assert/strict'
import test from 'node:test'
import { SitePermissions, sitePermissionTarget } from './browser-permissions.js'

const never = new AbortController().signal

test('only the three promptable permissions on http(s) main-frame pages can ever be asked', () => {
  assert.deepEqual(sitePermissionTarget('clipboard-sanitized-write', 'http://localhost:3000/app?x=1#y', true), { origin: 'http://localhost:3000', permission: 'clipboard-sanitized-write' })
  assert.deepEqual(sitePermissionTarget('notifications', 'https://example.com/', true), { origin: 'https://example.com', permission: 'notifications' })
  assert.equal(sitePermissionTarget('clipboard-read', 'https://example.com/', true)?.permission, 'clipboard-read')
  for (const permission of ['media', 'geolocation', 'display-capture', 'midi', 'usb', 'fullscreen', 'openExternal', 'toString', '__proto__', 'constructor']) {
    assert.equal(sitePermissionTarget(permission, 'https://example.com/', true), null, permission)
  }
  assert.equal(sitePermissionTarget('notifications', 'https://example.com/', false), null, 'frames are never asked')
  assert.equal(sitePermissionTarget('notifications', undefined, true), null)
  for (const url of ['file:///C:/secret.html', 'about:blank', 'data:text/html,x', 'javascript:alert(1)', 'devtools://devtools/x', 'not a url']) {
    assert.equal(sitePermissionTarget('notifications', url, true), null, url)
  }
})

test('the first answer is remembered per origin and permission, and only allowed answers confirm checks', async () => {
  const asked: string[] = []
  const answers = [true, false, true]
  const permissions = new SitePermissions(async (origin, permission) => { asked.push(`${origin} ${permission}`); return answers.shift() ?? null })
  assert.equal(permissions.allowed('http://a.test', 'notifications'), false)
  assert.equal(await permissions.request('http://a.test', 'notifications', never), true)
  assert.equal(await permissions.request('http://a.test', 'notifications', never), true)
  assert.equal(permissions.allowed('http://a.test', 'notifications'), true)
  assert.equal(await permissions.request('http://b.test', 'notifications', never), false)
  assert.equal(permissions.allowed('http://b.test', 'notifications'), false)
  assert.equal(await permissions.request('http://b.test', 'notifications', never), false)
  assert.equal(await permissions.request('http://a.test', 'clipboard-read', never), true)
  assert.deepEqual(asked, ['http://a.test notifications', 'http://b.test notifications', 'http://a.test clipboard-read'])
  assert.deepEqual(permissions.list().map(entry => [entry.origin, entry.permission, entry.decision]),
    [['http://a.test', 'notifications', 'allow'], ['http://b.test', 'notifications', 'block'], ['http://a.test', 'clipboard-read', 'allow']])
})

test('simultaneous requests share one prompt and different prompts never overlap', async () => {
  let open = 0; let maximum = 0; let calls = 0
  const permissions = new SitePermissions(async () => {
    calls++; open++; maximum = Math.max(maximum, open)
    await new Promise(resolve => setTimeout(resolve, 20))
    open--; return true
  })
  const results = await Promise.all([
    permissions.request('http://a.test', 'notifications', never), permissions.request('http://a.test', 'notifications', never),
    permissions.request('http://b.test', 'notifications', never), permissions.request('http://c.test', 'clipboard-read', never),
  ])
  assert.deepEqual(results, [true, true, true, true])
  assert.equal(calls, 3)
  assert.equal(maximum, 1)
})

test('a dismissed prompt or a closed page blocks the request without remembering anything', async () => {
  let answer: boolean | null = null
  const permissions = new SitePermissions(async () => answer)
  assert.equal(await permissions.request('http://a.test', 'notifications', never), false)
  assert.deepEqual(permissions.list(), [])
  const closed = new AbortController()
  answer = true
  closed.abort()
  assert.equal(await permissions.request('http://a.test', 'notifications', closed.signal), false)
  const closing = new AbortController()
  const slow = new SitePermissions(async () => { closing.abort(); return true })
  assert.equal(await slow.request('http://a.test', 'notifications', closing.signal), false)
  assert.deepEqual(slow.list(), [])
  assert.equal(await permissions.request('http://a.test', 'notifications', never), true, 'the next request may ask again')
})

test('removing an answer asks again, and the list is capped', async () => {
  let calls = 0
  const permissions = new SitePermissions(async () => { calls++; return true })
  await permissions.request('http://a.test', 'notifications', never)
  const [entry] = permissions.list()
  assert.equal(permissions.forget(entry!.id + 100), false)
  assert.equal(permissions.forget(entry!.id), true)
  assert.equal(permissions.allowed('http://a.test', 'notifications'), false)
  await permissions.request('http://a.test', 'notifications', never)
  assert.equal(calls, 2)
  for (let index = 0; index < 60; index++) await permissions.request(`http://site${index}.test`, 'notifications', never)
  assert.equal(permissions.list().length, 50)
  const before = calls
  assert.equal(await permissions.request('http://one-more.test', 'notifications', never), false)
  assert.equal(calls, before)
  permissions.clear()
  assert.deepEqual(permissions.list(), [])
})

test('a burst of simultaneous unknown sites cannot get past the cap', async () => {
  let calls = 0
  const permissions = new SitePermissions(async () => { calls++; return true })
  const results = await Promise.all(Array.from({ length: 60 }, (_item, index) => permissions.request(`http://burst${index}.test`, 'notifications', never)))
  assert.equal(results.filter(Boolean).length, 50)
  assert.equal(results.slice(50).some(Boolean), false)
  assert.equal(calls, 50)
  assert.equal(permissions.list().length, 50)
})
