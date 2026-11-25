import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { CheckpointStore, type CheckpointTurn } from './checkpoint-store.js'
import { createGitFixture, type GitFixture } from './fixtures/git-fixture.js'
import { SUPERSEDED_NOTE, TurnCheckpoints, type TurnTarget } from './turn-checkpoints.js'

interface Rig { fixture: GitFixture; store: CheckpointStore; repo: string; turns: TurnCheckpoints; targets: Map<string, TurnTarget | null>; refusals: Map<string, string>; gated: string[]; settings: { enabled: boolean }; errors: unknown[]; list(session?: string): Promise<CheckpointTurn[]> }

async function rig(t: test.TestContext): Promise<Rig | null> {
  const fixture = await createGitFixture()
  if (!fixture) { t.skip('git is not installed'); return null }
  t.after(() => fixture.cleanup())
  const store = new CheckpointStore({ root: join(fixture.root, 'checkpoints'), runner: fixture.runner })
  const repo = fixture.repo('work')
  const targets = new Map<string, TurnTarget | null>([['tab', { sessionId: 's', worktreeRoot: repo, projectPath: repo }]])
  const refusals = new Map<string, string>()
  const gated: string[] = []
  const settings = { enabled: true }
  const errors: unknown[] = []
  const turns = new TurnCheckpoints({ store, enabled: () => settings.enabled, resolve: async tabId => targets.get(tabId) ?? null,
    gate: async target => { gated.push(target.sessionId); return refusals.get(target.sessionId) ?? null }, onError: error => errors.push(error) })
  return { fixture, store, repo, turns, targets, refusals, gated, settings, errors, list: async (session = 's') => (await store.turns(repo))[session] ?? [] }
}

test('a turn is snapshotted when its prompt arrives and when the session becomes idle', async (t) => {
  const made = await rig(t)
  if (!made) return
  const { store, repo, turns, list, errors } = made
  turns.promptStarted('tab', 'add a file')
  await turns.settled()
  writeFileSync(join(repo, 'made.txt'), 'agent\n')
  // A second prompt before idle joins the running turn.
  turns.promptStarted('tab', 'and one more thing')
  turns.idle('tab')
  await turns.settled()
  const records = await list()
  assert.equal(records.length, 1)
  assert.equal(records[0]!.label, 'add a file')
  assert.equal(records[0]!.state, 'complete')
  assert.equal(await store.fileAt(repo, records[0]!.before!.commit!, 'made.txt'), null)
  assert.equal((await store.fileAt(repo, records[0]!.after!.commit!, 'made.txt'))?.toString(), 'agent\n')
  // Idle with no turn open does nothing.
  turns.idle('tab')
  await turns.settled()
  assert.equal((await list()).length, 1)
  assert.deepEqual(errors, [])
})

test('edits between turns belong to no turn', async (t) => {
  const made = await rig(t)
  if (!made) return
  const { store, repo, turns, list } = made
  turns.promptStarted('tab', 'one')
  turns.idle('tab')
  await turns.settled()
  writeFileSync(join(repo, 'mine.txt'), 'typed by the person\n')
  turns.promptStarted('tab', 'two')
  await turns.settled()
  writeFileSync(join(repo, 'agent.txt'), 'agent\n')
  turns.idle('tab')
  await turns.settled()
  const [, second] = await list()
  assert.equal((await store.fileAt(repo, second!.before!.commit!, 'mine.txt'))?.toString(), 'typed by the person\n', 'already there when the turn started')
  assert.equal(await store.fileAt(repo, second!.before!.commit!, 'agent.txt'), null)
})

test('a task the desktop sends starts its turn before the paste, and an aborted send ran no turn', async (t) => {
  const made = await rig(t)
  if (!made) return
  const { turns, list } = made
  turns.preSend('tab')
  turns.promptStarted('tab', 'Resolve the conflict in a.txt')
  turns.idle('tab')
  await turns.settled()
  let records = await list()
  assert.equal(records.length, 1)
  assert.equal(records[0]!.label, 'Resolve the conflict in a.txt')
  assert.equal(records[0]!.state, 'complete')

  turns.preSend('tab')
  turns.sendAborted('tab')
  await turns.settled()
  records = await list()
  assert.equal(records[1]!.state, 'incomplete')
  assert.equal(records[1]!.note, 'The task was not sent')
  assert.equal(records[1]!.after, null)
})

test('an end snapshot is not taken once another prompt has started', async (t) => {
  const made = await rig(t)
  if (!made) return
  const { turns, list } = made
  turns.promptStarted('tab', 'first')
  // Idle and the next prompt arrive before the first turn's snapshots have run.
  turns.idle('tab')
  turns.promptStarted('tab', 'second')
  turns.idle('tab')
  await turns.settled()
  const records = await list()
  assert.equal(records.length, 2)
  assert.equal(records[0]!.state, 'incomplete')
  assert.equal(records[0]!.note, SUPERSEDED_NOTE)
  assert.equal(records[0]!.after, null)
  assert.equal(records[1]!.state, 'complete')
})

test('a closed tab, a refused repository, a session with no target and the off setting', async (t) => {
  const made = await rig(t)
  if (!made) return
  const { repo, turns, targets, refusals, settings, list, store, errors } = made
  turns.promptStarted('tab', 'unfinished')
  turns.tabClosed('tab')
  await turns.settled()
  assert.equal((await list())[0]!.note, 'The session ended during this turn')

  targets.set('held', { sessionId: 'held-session', worktreeRoot: repo, projectPath: repo })
  refusals.set('held-session', 'This repository needs review in the Git panel')
  turns.promptStarted('held', 'p')
  turns.idle('held')
  await turns.settled()
  const [held] = await list('held-session')
  assert.equal(held!.state, 'incomplete')
  assert.equal(held!.before!.commit, null)
  assert.equal(held!.note, 'This repository needs review in the Git panel')

  targets.set('none', null)
  turns.promptStarted('none', 'p')
  turns.idle('none')
  settings.enabled = false
  turns.promptStarted('tab', 'while off')
  turns.preSend('tab')
  turns.idle('tab')
  await turns.settled()
  assert.equal((await list()).length, 1)
  assert.deepEqual(Object.keys(await store.turns(repo)).sort(), ['held-session', 's'])
  assert.deepEqual(errors, [])
})

test('a prompt that arrives while an end snapshot is being taken discards it', async (t) => {
  const fixture = await createGitFixture()
  if (!fixture) { t.skip('git is not installed'); return }
  t.after(() => fixture.cleanup())
  // The end snapshot of a turn stops after Git has listed the files, as it would on a large repository.
  let hold: (() => void) | null = null
  let reached: (() => void) | null = null
  let pauseNext = false
  class Paused extends CheckpointStore {
    override async eligiblePaths(worktreeRoot: string, signal?: AbortSignal) {
      const found = await super.eligiblePaths(worktreeRoot, signal)
      if (pauseNext) { pauseNext = false; await new Promise<void>(resolve => { hold = resolve; reached?.() }) }
      return found
    }
  }
  const store = new Paused({ root: join(fixture.root, 'checkpoints'), runner: fixture.runner })
  const repo = fixture.repo('work')
  const turns = new TurnCheckpoints({ store, enabled: () => true, resolve: async tabId => ({ sessionId: tabId === 'tab' ? 's' : 'other', worktreeRoot: repo, projectPath: repo }), gate: async () => null })
  const paused = (): Promise<void> => new Promise<void>(resolve => { reached = resolve; pauseNext = true })

  turns.promptStarted('tab', 'first')
  await turns.settled()
  let stopped = paused()
  turns.idle('tab')
  await stopped
  turns.promptStarted('tab', 'second')
  writeFileSync(join(repo, 'second.txt'), 'written by the second turn\n')
  hold!()
  turns.idle('tab')
  await turns.settled()
  let records = (await store.turns(repo)).s!
  assert.equal(records[0]!.state, 'incomplete')
  assert.equal(records[0]!.note, SUPERSEDED_NOTE)
  assert.equal(records[0]!.after, null, 'no end snapshot that holds the file of the second turn')
  assert.equal(records[1]!.state, 'complete')

  // The same from another tab that works in the same folder.
  turns.promptStarted('tab', 'third')
  await turns.settled()
  stopped = paused()
  turns.idle('tab')
  await stopped
  turns.promptStarted('neighbour', 'from another tab')
  await new Promise(resolve => setTimeout(resolve, 100))
  hold!()
  turns.idle('neighbour')
  await turns.settled()
  records = (await store.turns(repo)).s!
  assert.equal(records[2]!.state, 'incomplete')
  assert.equal(records[2]!.note, SUPERSEDED_NOTE)
  assert.equal((await store.turns(repo)).other![0]!.state, 'complete')
})

test('the trust gate is asked right before each snapshot, the end one too', async (t) => {
  const made = await rig(t)
  if (!made) return
  const { store, repo, turns, refusals, gated, list } = made
  turns.promptStarted('tab', 'changes the repository settings')
  await turns.settled()
  assert.deepEqual(gated, ['s'])
  // During the turn the agent adds a setting that can start a program: the gate now says no.
  refusals.set('s', 'This repository needs review in the Git panel')
  writeFileSync(join(repo, 'made.txt'), 'agent\n')
  turns.idle('tab')
  await turns.settled()
  assert.deepEqual(gated, ['s', 's'], 'asked again for the end snapshot')
  const [record] = await list()
  assert.ok(record!.before!.commit)
  assert.equal(record!.after!.commit, null, 'no Git ran in the project for the end snapshot')
  assert.equal(record!.after!.reason, 'This repository needs review in the Git panel')
  assert.equal(record!.state, 'incomplete')
  assert.equal(await store.fileAt(repo, record!.before!.commit!, 'made.txt'), null)
})

test('turning the feature off leaves nothing behind, whatever was under way', async (t) => {
  const made = await rig(t)
  if (!made) return
  const { store, repo, turns, settings } = made
  const off = async (): Promise<void> => { settings.enabled = false; turns.turnedOff(); await store.clear() }
  // Off in the same moment a prompt starts a turn.
  turns.promptStarted('tab', 'racing the switch')
  await off()
  await turns.settled()
  assert.equal(existsSync(store.storeDirectory(repo)), false, 'the start snapshot was not written after the delete')

  // Off while a turn is open, then on again before the session becomes idle.
  settings.enabled = true
  turns.promptStarted('tab', 'open across the switch')
  await turns.settled()
  assert.equal(existsSync(store.storeDirectory(repo)), true)
  await off()
  settings.enabled = true
  turns.idle('tab')
  await turns.settled()
  assert.equal(existsSync(store.storeDirectory(repo)), false, 'the end snapshot of a turn from before the switch is not written')

  // A turn that starts after it is on again is recorded as usual.
  turns.promptStarted('tab', 'after')
  turns.idle('tab')
  await turns.settled()
  assert.equal((await store.turns(repo)).s![0]!.state, 'complete')

  // A turn that was open at the switch is forgotten: the next prompt starts a turn of its own instead of joining it.
  turns.promptStarted('tab', 'open at the switch')
  await turns.settled()
  await off()
  settings.enabled = true
  turns.promptStarted('tab', 'fresh')
  turns.idle('tab')
  await turns.settled()
  const fresh = (await store.turns(repo)).s!
  assert.deepEqual(fresh.map(turn => [turn.label, turn.state]), [['fresh', 'complete']])
})

test('an end registered before its folder was known is still discarded by a turn that started there meanwhile', async (t) => {
  const fixture = await createGitFixture()
  if (!fixture) { t.skip('git is not installed'); return }
  t.after(() => fixture.cleanup())
  const store = new CheckpointStore({ root: join(fixture.root, 'checkpoints'), runner: fixture.runner })
  const repo = fixture.repo('work')
  // The first tab's target takes a while to work out; the second tab's is known at once.
  let release: (() => void) | null = null
  const slow = new Promise<void>(resolve => { release = resolve })
  const turns = new TurnCheckpoints({
    store, enabled: () => true, gate: async () => null,
    resolve: async tabId => { if (tabId === 'first') await slow; return { sessionId: tabId, worktreeRoot: repo, projectPath: repo } },
  })
  turns.promptStarted('first', 'slow to resolve')
  turns.idle('first')
  turns.promptStarted('second', 'starts in the same folder')
  await new Promise(resolve => setTimeout(resolve, 300))
  writeFileSync(join(repo, 'second.txt'), 'second\n')
  release!()
  await turns.settled()
  const first = (await store.turns(repo)).first![0]!
  assert.equal(first.state, 'incomplete')
  assert.equal(first.note, SUPERSEDED_NOTE)
  assert.equal(first.after, null)
})
