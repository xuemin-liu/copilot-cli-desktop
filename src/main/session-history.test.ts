import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { scanSessionHistory } from './session-history.js'

const ID = '11111111-1111-4111-8111-111111111111'
const start = JSON.stringify({ type: 'session.start', data: { sessionId: ID } }) + '\n'
async function fixture(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-history-unit-'))
  try { await action(directory) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

test('streaming history preserves UTF-8 across chunk boundaries and hashes ordered message contents', async () => {
  await fixture(async (directory) => {
    const contents = ['界'.repeat(30_000), 'second message']
    const history = start + contents.map((content) => JSON.stringify({ type: 'user.message', data: { content } }) + '\n').join('')
    const path = join(directory, 'events.jsonl')
    const snapshot = join(directory, 'snapshot.jsonl')
    await writeFile(path, history + '{"partial":')
    const actual = await scanSessionHistory(path, ID, snapshot)
    const expected = createHash('sha256')
    for (const content of contents) expected.update(JSON.stringify(['user.message', content]) + '\n')
    assert.deepEqual(actual, { digest: expected.digest('hex'), messages: 2 })
    assert.equal(await readFile(snapshot, 'utf8'), history)
    await assert.rejects(scanSessionHistory(path, ID), /incomplete record/)
    assert.deepEqual(await scanSessionHistory(snapshot, ID), actual)
  })
})

test('large history scanning yields to other event-loop work', async () => {
  await fixture(async (directory) => {
    const path = join(directory, 'events.jsonl')
    const record = JSON.stringify({ type: 'assistant.message', data: { content: 'x'.repeat(4000) } }) + '\n'
    await writeFile(path, start + record.repeat(2000))
    let ticks = 0
    const timer = setInterval(() => ticks++, 0)
    try {
      const result = await scanSessionHistory(path, ID)
      assert.equal(result.messages, 2000)
      assert.ok(ticks > 5, `Only ${ticks} event-loop ticks during an 8 MiB scan`)
    } finally { clearInterval(timer) }
  })
})

test('oversized individual records fail with a bounded, actionable error', async () => {
  await fixture(async (directory) => {
    const path = join(directory, 'events.jsonl')
    await writeFile(path, start + 'x'.repeat(8 * 1024 * 1024 + 1) + '\n')
    await assert.rejects(scanSessionHistory(path, ID), /8 MiB safe-fork limit/)
  })
})
