import assert from 'node:assert/strict'
import fs, { type FileHandle } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { forkSessionSnapshot } from './session-fork.js'
import { scanSessionHistory } from './session-history.js'
import type { CopilotResolution } from './types.js'

const SOURCE = '11111111-1111-4111-8111-111111111111'
const history = JSON.stringify({ type: 'session.start', data: { sessionId: SOURCE } }) + '\n'
const resolution: CopilotResolution = { kind: 'direct', command: 'copilot', prefixArgs: [], resolvedPath: null, version: '1.0.82', error: null }

/** Inject only the failing filesystem operation; scan/staging and all other
 * I/O use real files. These tests run sequentially in their own test process.
 * Restore both the default object and named builtin exports after each test.
 */
async function fixture(t: TestContext, action: (directory: string, source: string, handles: FileHandle[]) => Promise<void>, fault: 'close' | 'open' | 'write', failure: Error): Promise<void> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'desktop-history-io-unit-'))
  const source = join(directory, 'session-state', SOURCE)
  const handles: FileHandle[] = []
  const realOpen = fs.open
  try {
    await fs.mkdir(source, { recursive: true })
    await fs.writeFile(join(source, 'events.jsonl'), history)
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const snapshot = args[1] === 'wx'
      if (snapshot && fault === 'open') throw failure
      const handle = await realOpen(...args)
      handles.push(handle)
      if (snapshot && fault === 'close') {
        const close = handle.close.bind(handle)
        t.mock.method(handle, 'close', async () => {
          // Close the test's real handle, then simulate a rejected close.
          await close()
          throw failure
        })
      }
      if (snapshot && fault === 'write') t.mock.method(handle, 'writeFile', async () => { throw failure })
      return handle
    })
    syncBuiltinESMExports()
    await action(directory, source, handles)
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    // Also clean up handles if the assertion intentionally catches a regression.
    try { await Promise.all(handles.filter((handle) => handle.fd !== -1).map((handle) => handle.close())) }
    finally { await fs.rm(directory, { recursive: true, force: true }) }
  }
}

test('snapshot close failure still closes the source handle and preserves the error', async (t) => {
  const failure = Object.assign(new Error('EIO: simulated snapshot close failure'), { code: 'EIO' })
  await fixture(t, async (directory, source, handles) => {
    await assert.rejects(scanSessionHistory(join(source, 'events.jsonl'), SOURCE, join(directory, 'snapshot.jsonl')), (error) => error === failure)
    assert.equal(handles.length, 2)
    assert.equal(handles[0]!.fd, -1, 'The source handle must close even when snapshot close rejects')
    assert.equal(handles[1]!.fd, -1)
    assert.equal(await fs.readFile(join(source, 'events.jsonl'), 'utf8'), history)
  }, 'close', failure)
})

for (const [fault, code] of [['open', 'EACCES'], ['write', 'ENOSPC'], ['close', 'EIO']] as const) {
  test(`snapshot ${fault} failure is reported as I/O (${code}), not invalid history`, async (t) => {
    const failure = Object.assign(new Error(`${code}: simulated snapshot ${fault} failure`), { code })
    await fixture(t, async (directory, source, handles) => {
      let helperCalled = false
      await assert.rejects(forkSessionSnapshot(resolution, directory, { COPILOT_HOME: directory }, SOURCE, 'Side', async () => {
        helperCalled = true
        throw new Error('The helper must not run after an I/O failure')
      }), (error: Error) => {
        assert.match(error.message, /Could not read or snapshot the source history/)
        assert.ok(error.message.includes(code))
        assert.doesNotMatch(error.message, /unsupported or invalid/)
        assert.equal(error.cause, failure)
        return true
      })
      assert.equal(helperCalled, false)
      assert.equal(handles.length, fault === 'open' ? 1 : 2)
      assert.ok(handles.every((handle) => handle.fd === -1), 'All opened handles must close')
      assert.equal(await fs.readFile(join(source, 'events.jsonl'), 'utf8'), history)
      assert.deepEqual(await fs.readdir(join(directory, 'session-state')), [SOURCE])
    }, fault, failure)
  })
}
