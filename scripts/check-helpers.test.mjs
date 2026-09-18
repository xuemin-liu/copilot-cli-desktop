import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ui, readEvents } from './check-helpers.mjs'
import { selectCheckMode } from './check-modes.mjs'
import { createCheckModelServer } from './check-model-server.mjs'
import { preserveClipboard } from './check-clipboard.mjs'

test('renderer calls time out and propagate renderer failures', async () => {
  await assert.rejects(ui({ webContents: { executeJavaScript: () => new Promise(() => {}) } }, 'hung', 20), /Renderer timeout: hung/)
  await assert.rejects(ui({ webContents: { executeJavaScript: async () => { throw new Error('destroyed') } } }, 'test'), /destroyed/)
})

test('conflicting modes are rejected before launching the fixture', () => {
  assert.throws(() => selectCheckMode(['--native-paste', '--popout']), /Choose one check mode/)
  assert.throws(() => selectCheckMode(['--clipboard-switch', '--clipboard-status']), /Choose one check mode/)
  assert.equal(selectCheckMode(['--native-paste']).artifacts, 'native-paste')
  assert.equal(selectCheckMode([]), undefined)
})

test('event polling ignores an incomplete tail and consumes it once completed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'check-jsonl-'))
  try {
    const path = join(directory, 'events.jsonl')
    await writeFile(path, '{"type":"one"}\n{"type":')
    assert.deepEqual(await readEvents(path), [{ type: 'one' }])
    await writeFile(path, '{"type":"one"}\n{"type":"two"}\n')
    assert.deepEqual(await readEvents(path), [{ type: 'one' }, { type: 'two' }])
    await writeFile(path, 'bad complete record\n')
    await assert.rejects(readEvents(path), SyntaxError)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('recording does not break GET/non-JSON requests and appends JSON model evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'check-server-'))
  const recordingPath = join(directory, 'requests.jsonl')
  const server = createCheckModelServer({ recordingPath })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const models = await fetch(base + '/v1/models')
    assert.equal(models.status, 200)
    assert.equal((await models.json()).data[0].id, 'ui-check-model')
    assert.equal((await fetch(base, { method: 'POST', body: 'not json' })).status, 200)
    for (const id of [1, 2]) assert.equal((await fetch(base, { method: 'POST', body: JSON.stringify({ id }) })).status, 200)
    assert.deepEqual(await readEvents(recordingPath), [{ id: 1 }, { id: 2 }])
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

test('clipboard restore preserves original formats and refuses unsupported ones', () => {
  let data = { 'text/plain': 'original' }
  let restored
  const warnings = []
  const clipboard = { availableFormats: () => Object.keys(data), readText: () => data['text/plain'],
    readBuffer: format => Buffer.from(data[format]), write: value => { restored = value }, clear: () => { restored = {} } }
  const saved = preserveClipboard(clipboard, value => warnings.push(value))
  data = { 'image/png': 'fixture' }; saved.claim(); saved.restore()
  assert.deepEqual(restored, { text: 'original' })
  restored = undefined
  data = { 'text/plain': 'new user copy' }; saved.restore()
  assert.equal(restored, undefined)
  assert.equal(warnings.length, 1)
  data = { 'text/uri-list': 'files' }
  assert.throws(() => preserveClipboard(clipboard), /Clipboard was not changed/)
  assert.deepEqual(data, { 'text/uri-list': 'files' })
  data = {}
  const empty = preserveClipboard(clipboard)
  data = { 'image/png': 'fixture' }; empty.claim(); empty.restore()
  assert.deepEqual(restored, {})
})
