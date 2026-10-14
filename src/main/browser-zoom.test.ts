import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BrowserZoom, nextZoomFactor } from './browser-zoom.js'

test('zoom moves one Chrome step at a time, stops at the ends and resets to 100%', () => {
  assert.equal(nextZoomFactor(1, 'in'), 1.1)
  assert.equal(nextZoomFactor(1, 'out'), 0.9)
  assert.equal(nextZoomFactor(1.5, 'in'), 1.75)
  assert.equal(nextZoomFactor(0.25, 'out'), 0.25)
  assert.equal(nextZoomFactor(5, 'in'), 5)
  assert.equal(nextZoomFactor(2, 'reset'), 1)
  let zoom = 1
  for (let index = 0; index < 30; index++) zoom = nextZoomFactor(zoom, 'in')
  assert.equal(zoom, 5)
})

test('a factor between steps snaps to the next step in the pressed direction', () => {
  assert.equal(nextZoomFactor(1.05, 'in'), 1.1)
  assert.equal(nextZoomFactor(1.05, 'out'), 1)
  assert.equal(nextZoomFactor(1.2, 'in'), 1.25)
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(nextZoomFactor(bad, 'in'), 1)
})

test('zoom is saved per site, shared live with every browser and kept across launches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-zoom-'))
  try {
    const file = join(root, 'browser-zoom.json')
    const zoom = new BrowserZoom(file)
    const changes: string[] = []
    const unsubscribe = zoom.subscribe((site, factor) => changes.push(`${site} ${factor}`))
    zoom.set('http://localhost:3000/app?x=1', 1.25)
    // Like Chrome, zoom belongs to the host name, whatever the port or path.
    assert.equal(zoom.get('http://localhost:5173/other'), 1.25)
    assert.equal(zoom.get('https://example.com/'), 1)
    zoom.set('http://localhost:3000/', 1.25)
    zoom.set('file:///C:/page.html', 2)
    zoom.set('https://example.com/', 9)
    assert.deepEqual(changes, ['localhost 1.25'])
    unsubscribe()
    zoom.set('https://example.com/', 0.5)
    assert.deepEqual(changes, ['localhost 1.25'])
    await zoom.flush()
    const restored = new BrowserZoom(file)
    assert.equal(restored.get('http://localhost/'), 1.25)
    assert.equal(restored.get('https://example.com/a'), 0.5)
    // Back to 100% forgets the site.
    restored.set('https://example.com/', 1)
    await restored.flush()
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { localhost: 1.25 })

    await writeFile(file, JSON.stringify({ 'ok.test': 2, 'bad host/': 2, 'big.test': 50, 'text.test': '2', 'one.test': 1 }))
    const filtered = new BrowserZoom(file)
    assert.equal(filtered.get('http://ok.test/'), 2)
    for (const url of ['http://big.test/', 'http://text.test/', 'http://one.test/']) assert.equal(filtered.get(url), 1)
    const errors: string[] = []
    await writeFile(file, '{not json')
    assert.equal(new BrowserZoom(file, message => errors.push(message)).get('http://ok.test/'), 1)
    assert.equal(errors.length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
