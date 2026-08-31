import assert from 'node:assert/strict'
import test from 'node:test'
import { cp, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forkSessionSnapshot } from './session-fork.js'
import { SessionHistoryValidationError } from './session-history.js'
import type { CopilotResolution } from './types.js'

const SOURCE = '11111111-1111-4111-8111-111111111111'
const FORK = '22222222-2222-4222-8222-222222222222'
const resolution: CopilotResolution = { kind: 'direct', command: 'copilot', prefixArgs: [], resolvedPath: null, version: '1.0.82', error: null }
const history = JSON.stringify({ id: 'start', type: 'session.start', data: { sessionId: SOURCE } }) + '\n'
  + JSON.stringify({ id: 'user', type: 'user.message', data: { content: 'copied context' } }) + '\n'

async function fixture(action: (directory: string, source: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-fork-unit-'))
  const source = join(directory, 'session-state', SOURCE)
  try {
    await mkdir(join(source, 'files'), { recursive: true })
    await writeFile(join(source, 'events.jsonl'), history)
    await writeFile(join(source, 'workspace.yaml'), 'summary: Example\n')
    await writeFile(join(source, 'inuse.123.lock'), 'locked')
    await writeFile(join(source, '.workspace-fork.lock'), 'locked')
    await writeFile(join(source, 'files', 'artifact.txt'), 'session artifact')
    await action(directory, source)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test('isolated fork tolerates a CLI that overwrites its source, without touching the live history or locks', async () => {
  await fixture(async (directory, source) => {
    const id = await forkSessionSnapshot(resolution, directory, { COPILOT_HOME: directory }, SOURCE, 'Side', async (_resolution, cwd, env, sessionId, title) => {
      assert.equal(cwd, directory)
      assert.equal(sessionId, SOURCE)
      assert.equal(title, 'Side')
      assert.notEqual(env.COPILOT_HOME, directory)
      assert.equal(env.COPILOT_DISABLE_KEYTAR, '1')
      const stagedSource = join(env.COPILOT_HOME!, 'session-state', SOURCE)
      assert.equal(await readFile(join(stagedSource, 'events.jsonl'), 'utf8'), history)
      assert.equal(await readFile(join(stagedSource, 'files', 'artifact.txt'), 'utf8'), 'session artifact')
      const files = await readdir(stagedSource)
      assert.ok(!files.includes('inuse.123.lock') && !files.includes('.workspace-fork.lock'))
      await writeFile(join(stagedSource, 'events.jsonl'), 'overwritten by CLI fork info')
      const child = join(env.COPILOT_HOME!, 'session-state', FORK)
      await mkdir(child)
      await writeFile(join(child, 'events.jsonl'), history.replace(SOURCE, FORK))
      return FORK
    })
    assert.equal(id, FORK)
    assert.equal(await readFile(join(source, 'events.jsonl'), 'utf8'), history)
    assert.equal(await readFile(join(source, 'inuse.123.lock'), 'utf8'), 'locked')
    assert.equal(await readFile(join(directory, 'session-state', FORK, 'events.jsonl'), 'utf8'), history.replace(SOURCE, FORK))
    assert.deepEqual((await readdir(join(directory, 'session-state'))).sort(), [SOURCE, FORK])
  })
})

test('staging captures whole records and ignores a concurrently incomplete final event', async () => {
  await fixture(async (directory, source) => {
    await writeFile(join(source, 'events.jsonl'), history + '{"type":')
    await assert.rejects(forkSessionSnapshot(resolution, directory, { COPILOT_HOME: directory }, SOURCE, 'Side', async (_resolution, _cwd, env) => {
      assert.equal(await readFile(join(env.COPILOT_HOME!, 'session-state', SOURCE, 'events.jsonl'), 'utf8'), history)
      throw new Error('Test helper failure')
    }), /Test helper failure/)
    assert.equal(await readFile(join(source, 'events.jsonl'), 'utf8'), history + '{"type":')
    assert.deepEqual(await readdir(join(directory, 'session-state')), [SOURCE])
  })
})

test('fork refuses an existing destination and leaves both original sessions untouched', async () => {
  await fixture(async (directory, source) => {
    const destination = join(directory, 'session-state', FORK)
    await mkdir(destination)
    await writeFile(join(destination, 'events.jsonl'), 'existing history')
    await assert.rejects(forkSessionSnapshot(resolution, directory, { COPILOT_HOME: directory }, SOURCE, 'Side', async (_resolution, _cwd, env) => {
      await mkdir(join(env.COPILOT_HOME!, 'session-state', FORK))
      return FORK
    }), /already exists/)
    assert.equal(await readFile(join(destination, 'events.jsonl'), 'utf8'), 'existing history')
    assert.equal(await readFile(join(source, 'events.jsonl'), 'utf8'), history)
  })
})

test('fork validates source format and independent UUID before publishing', async () => {
  await fixture(async (directory, source) => {
    const env = { COPILOT_HOME: directory }
    for (const id of ['../escape', '--flag', '']) await assert.rejects(forkSessionSnapshot(resolution, directory, env, id, 'Side'), /full source session UUID/)
    for (const id of [SOURCE, '../escape']) {
      await assert.rejects(forkSessionSnapshot(resolution, directory, env, SOURCE, 'Side', async () => id), /independent fork/)
    }
    await writeFile(join(source, 'events.jsonl'), '{}\n')
    await assert.rejects(forkSessionSnapshot(resolution, directory, env, SOURCE, 'Side'), /history format/)
    assert.deepEqual(await readdir(join(directory, 'session-state')), [SOURCE])
  })
})

test('fork rejects missing, malformed, or context-less child history before publishing', async () => {
  await fixture(async (directory, source) => {
    for (const [content, detail] of [
      [null, /ENOENT/],
      ['{}\n', /no matching session start record/],
      ['{private-malformed-record}\n', /malformed saved record/],
      ['{partial', /incomplete record/],
      [JSON.stringify({ type: 'session.start', data: { sessionId: FORK } }) + '\n', /Conversation was not preserved/],
      [history.replace(SOURCE, FORK).replace('copied context', 'changed context'), /Conversation was not preserved/],
    ] as const) {
      await assert.rejects(forkSessionSnapshot(resolution, directory, { COPILOT_HOME: directory }, SOURCE, 'Side', async (_resolution, _cwd, env) => {
        const child = join(env.COPILOT_HOME!, 'session-state', FORK)
        await mkdir(child)
        if (content !== null) await writeFile(join(child, 'events.jsonl'), content)
        return FORK
      }), (error: Error) => {
        assert.match(error.message, detail)
        if (content === null) {
          assert.match(error.message, /Could not read the fork history/)
          assert.equal((error.cause as NodeJS.ErrnoException).code, 'ENOENT')
        } else {
          assert.match(error.message, /incomplete or unsupported fork history/)
          assert.ok(error.cause instanceof SessionHistoryValidationError)
        }
        assert.doesNotMatch(error.message, /private-malformed-record/)
        return true
      })
      assert.equal(await readFile(join(source, 'events.jsonl'), 'utf8'), history)
      assert.deepEqual(await readdir(join(directory, 'session-state')), [SOURCE])
    }
  })
})

test('nested attachments named like runtime files survive staging and publication', async () => {
  await fixture(async (directory, source) => {
    const names = ['events.jsonl', 'inuse.123.lock', '.workspace-fork.lock']
    for (const name of names) await writeFile(join(source, 'files', name), `attachment ${name}`)
    const id = await forkSessionSnapshot(resolution, directory, { COPILOT_HOME: directory }, SOURCE, 'Side', async (_resolution, _cwd, env) => {
      const stagedSource = join(env.COPILOT_HOME!, 'session-state', SOURCE)
      const child = join(env.COPILOT_HOME!, 'session-state', FORK)
      assert.ok(!(await readdir(stagedSource)).includes('inuse.123.lock'))
      await cp(stagedSource, child, { recursive: true })
      await writeFile(join(child, 'events.jsonl'), history.replace(SOURCE, FORK))
      return FORK
    })
    for (const name of names) {
      assert.equal(await readFile(join(directory, 'session-state', id, 'files', name), 'utf8'), `attachment ${name}`)
      assert.equal(await readFile(join(source, 'files', name), 'utf8'), `attachment ${name}`)
    }
  })
})

test('Windows runtime filename exclusions ignore case', { skip: process.platform !== 'win32' }, async () => {
  await fixture(async (directory, source) => {
    await rename(join(source, 'events.jsonl'), join(source, 'EVENTS.JSONL'))
    await rename(join(source, 'inuse.123.lock'), join(source, 'INUSE.123.LOCK'))
    await assert.rejects(forkSessionSnapshot(resolution, directory, { COPILOT_HOME: directory }, SOURCE, 'Side', async (_resolution, _cwd, env) => {
      const stagedSource = join(env.COPILOT_HOME!, 'session-state', SOURCE)
      const names = await readdir(stagedSource)
      assert.ok(names.includes('events.jsonl'))
      assert.ok(!names.includes('EVENTS.JSONL') && !names.includes('INUSE.123.LOCK'))
      assert.equal(await readFile(join(stagedSource, 'events.jsonl'), 'utf8'), history)
      throw new Error('Test inspection complete')
    }), /Test inspection complete/)
    assert.equal(await readFile(join(source, 'EVENTS.JSONL'), 'utf8'), history)
  })
})

test('nested symlinks are rejected before the helper runs and cleanup preserves their target', async () => {
  await fixture(async (directory, source) => {
    const target = join(directory, 'external')
    await mkdir(target)
    await writeFile(join(target, 'sentinel'), 'untouched')
    await symlink(target, join(source, 'files', 'events.jsonl'), process.platform === 'win32' ? 'junction' : 'dir')
    let called = false
    await assert.rejects(forkSessionSnapshot(resolution, directory, { COPILOT_HOME: directory }, SOURCE, 'Side', async () => { called = true; return FORK }), /symbolic links/)
    assert.equal(called, false)
    assert.equal(await readFile(join(target, 'sentinel'), 'utf8'), 'untouched')
    assert.equal(await readFile(join(source, 'events.jsonl'), 'utf8'), history)
    assert.deepEqual(await readdir(join(directory, 'session-state')), [SOURCE])
  })
})

test('malformed source records return actionable errors without publishing a fork', async () => {
  await fixture(async (directory, source) => {
    for (const malformed of ['{bad json}\n', 'null\n']) {
      await writeFile(join(source, 'events.jsonl'), history + malformed + history)
      let called = false
      await assert.rejects(forkSessionSnapshot(resolution, directory, { COPILOT_HOME: directory }, SOURCE, 'Side', async () => { called = true; return FORK }), (error: Error) => {
        assert.ok(!(error instanceof SyntaxError))
        assert.match(error.message, /source history format.*malformed saved record/)
        return true
      })
      assert.equal(called, false)
      assert.equal(await readFile(join(source, 'events.jsonl'), 'utf8'), history + malformed + history)
      assert.deepEqual(await readdir(join(directory, 'session-state')), [SOURCE])
    }
  })
})
