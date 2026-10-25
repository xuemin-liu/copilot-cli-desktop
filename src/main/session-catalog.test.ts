import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MAX_PROMPT_CHARS, listStoredSessions, promptText, promptsIn, type SessionCatalogCache } from './session-catalog.js'

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444']
const prompt = (content: string): string => JSON.stringify({ type: 'user.message', data: { content } })
const start = (cwd: string): string => JSON.stringify({ type: 'session.start', data: { startTime: '2026-10-01T10:00:00.000Z', context: { cwd } } })

async function store(action: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'session-catalog-'))
  try { await action(root) } finally { await rm(root, { recursive: true, force: true }) }
}

async function session(root: string, id: string, events: string[], workspace?: string, at?: Date): Promise<void> {
  await mkdir(join(root, id), { recursive: true })
  await writeFile(join(root, id, 'events.jsonl'), events.map((line) => `${line}\n`).join(''))
  if (workspace !== undefined) await writeFile(join(root, id, 'workspace.yaml'), workspace)
  if (at) for (const file of ['events.jsonl', ...(workspace !== undefined ? ['workspace.yaml'] : [])]) await utimes(join(root, id, file), at, at)
}

test('stored sessions list their name, folder, branch, and first and latest prompt, newest first', async () => store(async (root) => {
  await session(root, ids[0]!, [start('D:\\work\\app'), prompt('fix the login bug'), '{"type":"assistant.message"}', prompt('now add a test')],
    'id: x\ncwd: D:\\work\\app\ngit_root: D:\\work\\app\nrepository: me/app\nbranch: fix/login\nname: app\nuser_named: true\ncreated_at: 2026-10-01T10:00:00.000Z\n',
    new Date('2026-10-02T00:00:00Z'))
  // No workspace.yaml: the folder comes from the session.start record.
  await session(root, ids[1]!, [start('D:\\work\\other'), prompt('explain the parser')], undefined, new Date('2026-10-03T00:00:00Z'))
  // Never prompted: nothing to go back to.
  await session(root, ids[2]!, [start('D:\\work\\app')], 'name: app\n', new Date('2026-10-04T00:00:00Z'))
  await mkdir(join(root, 'not-a-session'))
  const listed = await listStoredSessions(root)
  assert.deepEqual(listed.map((entry) => entry.sessionId), [ids[1], ids[0]])
  const [other, app] = listed
  assert.equal(other!.cwd, 'D:\\work\\other')
  assert.equal(other!.name, null)
  assert.equal(other!.createdAt, Date.parse('2026-10-01T10:00:00.000Z'))
  assert.equal(other!.firstPrompt, 'explain the parser')
  assert.deepEqual({ name: app!.name, userNamed: app!.userNamed, branch: app!.branch, repository: app!.repository, gitRoot: app!.gitRoot },
    { name: 'app', userNamed: true, branch: 'fix/login', repository: 'me/app', gitRoot: 'D:\\work\\app' })
  assert.equal(app!.firstPrompt, 'fix the login bug')
  assert.equal(app!.lastPrompt, 'now add a test')
  assert.equal(app!.updatedAt, Date.parse('2026-10-02T00:00:00Z'))
}))

test('a long event log is read only at its head and tail, and both prompts are still found', async () => store(async (root) => {
  const filler = Array.from({ length: 4_000 }, (_, index) => JSON.stringify({ type: 'tool.execution_complete', data: { output: `${index} ${'x'.repeat(200)}` } }))
  await session(root, ids[3]!, [start('D:\\work\\app'), prompt('the first ask'), ...filler, prompt('a middle ask'), ...filler, prompt('the latest ask')])
  const [entry] = await listStoredSessions(root)
  assert.equal(entry!.firstPrompt, 'the first ask')
  assert.equal(entry!.lastPrompt, 'the latest ask')
}))

test('the list is bounded and a cache skips sessions whose files did not change', async () => store(async (root) => {
  for (const [index, id] of ids.entries()) await session(root, id, [start('D:\\w'), prompt(`ask ${index}`)], undefined, new Date(Date.UTC(2026, 9, index + 1)))
  assert.deepEqual((await listStoredSessions(root, { limit: 2 })).map((entry) => entry.firstPrompt), ['ask 3', 'ask 2'])
  const cache: SessionCatalogCache = new Map()
  const first = await listStoredSessions(root, { cache })
  const again = await listStoredSessions(root, { cache })
  assert.equal(again[0], first[0], 'unchanged: the cached entry')
  await session(root, ids[3]!, [start('D:\\w'), prompt('ask 3'), prompt('changed')], undefined, new Date(Date.UTC(2026, 9, 9)))
  assert.equal((await listStoredSessions(root, { cache }))[0]!.lastPrompt, 'changed')
}))

test('the limit counts only sessions with a prompt, so newer empty sessions cannot hide older conversations', async () => store(async (root) => {
  await session(root, ids[0]!, [start('D:\\w'), prompt('the real conversation')], undefined, new Date(Date.UTC(2026, 0, 1)))
  for (let index = 0; index < 40; index++) {
    const id = `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`
    await session(root, id, [start('D:\\w')], undefined, new Date(Date.UTC(2026, 5, 1, 0, index)))
  }
  await session(root, ids[1]!, [start('D:\\w'), prompt('a newer conversation')], undefined, new Date(Date.UTC(2026, 9, 1)))
  assert.deepEqual((await listStoredSessions(root, { limit: 2 })).map((entry) => entry.firstPrompt), ['a newer conversation', 'the real conversation'])
  assert.deepEqual((await listStoredSessions(root, { limit: 1 })).map((entry) => entry.firstPrompt), ['a newer conversation'])
}))

test('a missing store lists nothing', async () => {
  assert.deepEqual(await listStoredSessions(join(tmpdir(), 'no-such-session-store-for-tests')), [])
})

test('prompts are shown as one bounded line without control characters, and cut lines are skipped', () => {
  assert.equal(promptText('  two\r\nlines\u001b[31m\ttabbed  '), 'two lines [31m tabbed')
  assert.equal(promptText(' \n\t '), null)
  const long = promptText('y'.repeat(1_000))!
  assert.equal(long.length, MAX_PROMPT_CHARS)
  assert.ok(long.endsWith('…'))
  assert.deepEqual(promptsIn(`${prompt('kept')}\n{"type":"user.message","data":{"content":"cut off`), ['kept'])
  assert.deepEqual(promptsIn(JSON.stringify({ type: 'assistant.message', data: { content: 'mentions "user.message"' } })), [])
})
