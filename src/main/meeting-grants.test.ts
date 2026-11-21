import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { GRANT_DENIAL_MS, MeetingGrants, type GrantAnswer, type GrantQuestion } from './meeting-grants.js'

async function setup(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'meeting-grants-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'grants.json')
  const asked: GrantQuestion[] = []
  const answers: Array<GrantAnswer | Error | Promise<GrantAnswer>> = []
  let now = 1_000_000
  const make = (): MeetingGrants => new MeetingGrants({
    file, now: () => now,
    // Two spellings of one folder are one folder.
    canonical: async (folder) => { if (folder.includes('missing')) throw new Error('ENOENT'); return resolve(folder.replace(/[\\/]+$/, '')) },
    ask: async (question) => {
      asked.push(question)
      const answer = answers.shift() ?? 'deny'
      if (answer instanceof Error) throw answer
      return answer
    },
  })
  return { file, asked, answers, make, grants: make(), advance: (ms: number) => { now += ms } }
}

const PROJECT = resolve('/work/project')

test('attaching a folder\'s changes is asked of the person, and "always" is remembered for that folder only', async (t) => {
  const h = await setup(t)
  h.answers.push('once')
  assert.equal(await h.grants.attachChanges('Claude Code', PROJECT), true)
  assert.deepEqual(h.asked, [{ kind: 'attach-changes', agent: 'Claude Code', folder: PROJECT, meetingId: null }])
  // "For this meeting" is not remembered: the next meeting asks again.
  h.answers.push('always')
  assert.equal(await h.grants.attachChanges('Claude Code', PROJECT), true)
  assert.equal(h.asked.length, 2)
  // Remembered: not asked again, whatever the agent calls itself or however the folder is spelled, also after a restart.
  assert.equal(await h.grants.attachChanges('Someone else', `${PROJECT}/`), true)
  assert.equal(await h.make().attachChanges('Codex', PROJECT), true)
  assert.equal(h.asked.length, 2)
  assert.deepEqual(JSON.parse(await readFile(h.file, 'utf8')).folders.length, 1)
  // Another folder is another question.
  assert.equal(await h.grants.attachChanges('Claude Code', resolve('/work/other')), false)
  assert.equal(h.asked.length, 3)
  assert.equal(h.asked[2]?.folder, resolve('/work/other'))
})

test('a "no" stands for a while without asking again, then the person can be asked again', async (t) => {
  const h = await setup(t)
  h.answers.push('deny', 'once')
  assert.equal(await h.grants.attachChanges('Agent', PROJECT), false)
  // The same request repeated at once, as a program would: the person is not asked.
  for (let attempt = 0; attempt < 5; attempt++) assert.equal(await h.grants.attachChanges('Agent', PROJECT), false)
  assert.equal(h.asked.length, 1)
  h.advance(GRANT_DENIAL_MS)
  assert.equal(await h.grants.attachChanges('Agent', PROJECT), true)
  assert.equal(h.asked.length, 2)
})

test('only one question is on screen at a time; a second request is refused, not queued', async (t) => {
  const h = await setup(t)
  let answer!: (value: GrantAnswer) => void
  h.answers.push(new Promise<GrantAnswer>((resolveAnswer) => { answer = resolveAnswer }))
  const first = h.grants.attachChanges('Agent', PROJECT)
  await new Promise((resolveTurn) => setImmediate(resolveTurn))
  assert.equal(await h.grants.attachChanges('Other agent', resolve('/work/other')), false)
  assert.equal(await h.grants.readChanges('Reviewer', 'K7QF'), false)
  assert.equal(h.asked.length, 1)
  answer('once')
  assert.equal(await first, true)
  // The one that was turned away while the dialog was open was not answered "no" by the person, so it can ask now.
  h.answers.push('once')
  assert.equal(await h.grants.readChanges('Reviewer', 'K7QF'), true)
})

test('nobody to ask, a dialog that fails, a folder that is gone and a damaged file are all "no"', async (t) => {
  const h = await setup(t)
  h.answers.push(new Error('no window'))
  assert.equal(await h.grants.attachChanges('Agent', PROJECT), false)
  assert.equal(await h.grants.attachChanges('Agent', resolve('/work/missing')), false)
  assert.equal(h.asked.length, 1, 'a folder that cannot be resolved is not asked about')
  await writeFile(h.file, '{ not json')
  const reopened = h.make()
  assert.deepEqual(await reopened.rememberedFolders(), [])
  await writeFile(h.file, JSON.stringify({ folders: 'everything' }))
  assert.deepEqual(await h.make().rememberedFolders(), [])
})

test('reading a meeting\'s changes is asked for each request and never remembered; a "no" stands for the meeting', async (t) => {
  const h = await setup(t)
  h.answers.push('once', 'deny', 'once')
  assert.equal(await h.grants.readChanges('Codex', 'K7QF'), true)
  assert.deepEqual(h.asked[0], { kind: 'read-changes', agent: 'Codex', folder: null, meetingId: 'K7QF' })
  // A yes is for the seat that asked (the caller records it there): the next request is asked again.
  assert.equal(await h.grants.readChanges('Gemini', 'K7QF'), false)
  assert.equal(h.asked.length, 2)
  // After that "no", nobody is asked about this meeting for a while, whatever seat or name the request comes under:
  // taking a new seat costs a caller nothing.
  for (const name of ['Gemini', 'Gemini 2', 'Someone new']) assert.equal(await h.grants.readChanges(name, 'K7QF'), false)
  assert.equal(h.asked.length, 2)
  // Another meeting is another question.
  assert.equal(await h.grants.readChanges('Gemini', 'M2NB'), true)
  assert.equal(h.asked.length, 3)
  assert.deepEqual(await h.grants.rememberedFolders(), [])
})
