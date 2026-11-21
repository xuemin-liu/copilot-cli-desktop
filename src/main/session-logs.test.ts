import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionLogs } from './session-logs.js'

async function inFolder(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'session-logs-'))
  try { await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('chunks of a session reach its own file in the order they arrived, without waiting for each other', () => inFolder(async (directory) => {
  const logs = new SessionLogs(tabId => join(directory, 'sessions', `${tabId}.log`))
  const writes = [logs.write('tab-1', 'one '), logs.write('tab-2', 'other'), logs.write('tab-1', 'two '), logs.write('tab-1', 'three')]
  await Promise.all(writes)
  assert.equal(await readFile(join(directory, 'sessions', 'tab-1.log'), 'utf8'), 'one two three')
  assert.equal(await readFile(join(directory, 'sessions', 'tab-2.log'), 'utf8'), 'other')
}))

test('a session log stops at its byte limit with one line saying so, and never cuts a character in half', () => inFolder(async (directory) => {
  const file = join(directory, 'tab-1.log')
  const logs = new SessionLogs(() => file, 10)
  await logs.write('tab-1', '1234567')
  await logs.write('tab-1', 'ab€cd')   // € is three bytes: only "ab" fits in the three bytes left
  await logs.write('tab-1', 'dropped')
  await logs.write('tab-1', 'dropped too')
  assert.equal(await readFile(file, 'utf8'), '1234567ab\n[log truncated at 10 bytes]\n')
}))

test('a closed session is forgotten: the next one with the same tab id is counted from nothing', () => inFolder(async (directory) => {
  const file = join(directory, 'tab-1.log')
  const logs = new SessionLogs(() => file, 4)
  await logs.write('tab-1', '12345')
  logs.forget('tab-1')
  await logs.write('tab-1', 'ab')
  assert.equal(await readFile(file, 'utf8'), '1234\n[log truncated at 4 bytes]\nab')
}))

test('a failed chunk is reported to its caller, and the chunks after it are still written', async () => {
  const appended: string[] = []
  let fail = true
  const logs = new SessionLogs(() => 'tab-1.log', 1000, { append: async (_file, text) => { if (fail) { fail = false; throw new Error('disk full') } appended.push(text) } })
  const first = logs.write('tab-1', 'lost'), second = logs.write('tab-1', 'kept')
  await assert.rejects(first, /disk full/)
  await second
  assert.deepEqual(appended, ['kept'])
})

test('settled waits for everything queued for that session, failures included', async () => {
  const appended: string[] = []
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const logs = new SessionLogs(() => 'tab-1.log', 1000, { append: async (_file, text) => { await held; appended.push(text) } })
  void logs.write('tab-1', 'a'); void logs.write('tab-1', 'b')
  let done = false
  const settled = logs.settled('tab-1').then(() => { done = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(done, false)
  release()
  await settled
  assert.deepEqual(appended, ['a', 'b'])
  await logs.settled('tab-9')   // nothing queued: answers at once
})
