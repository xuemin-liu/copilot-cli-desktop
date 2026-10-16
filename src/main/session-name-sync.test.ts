import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PromptDraft, nameSyncAction, parseWorkspaceName, readCopilotSessionName, renameCommand } from './session-name-sync.js'

const yaml = (name: string, userNamed = false): string =>
  `id: 11111111-1111-4111-8111-111111111111\ncwd: D:\\work\nname: ${name}\nuser_named: ${userNamed}\nsummary_count: 0\n`

test('the name is read from Copilot\'s workspace.yaml in the forms Copilot writes', () => {
  assert.deepEqual(parseWorkspaceName(yaml('Say hello please')), { name: 'Say hello please', userNamed: false })
  assert.deepEqual(parseWorkspaceName(yaml('copilot-cli-desktop', true)), { name: 'copilot-cli-desktop', userNamed: true })
  assert.deepEqual(parseWorkspaceName(yaml("'Side: copilot-cli-desktop'", true)), { name: 'Side: copilot-cli-desktop', userNamed: true })
  assert.equal(parseWorkspaceName(yaml("'it''s here'"))?.name, "it's here")
  assert.equal(parseWorkspaceName(yaml('"Fix \\"login\\" race"'))?.name, 'Fix "login" race')
  assert.equal(parseWorkspaceName(yaml('C# notes # trailing comment'))?.name, 'C# notes')
  assert.equal(parseWorkspaceName('id: x\ncwd: D:\\work\n'), null, 'a session Copilot has not named yet')
  assert.equal(parseWorkspaceName(yaml('')), null)
  assert.equal(parseWorkspaceName(yaml('|')), null)
  assert.equal(parseWorkspaceName('summary:\n  name: nested\n'), null, 'only the top-level field counts')
})

test('a session\'s name is read again only when its file changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'name-sync-'))
  try {
    const id = '22222222-2222-4222-8222-222222222222'
    assert.deepEqual(await readCopilotSessionName(root, id), { mtimeMs: 0, value: null })
    assert.deepEqual(await readCopilotSessionName(root, '../escape'), { mtimeMs: 0, value: null })
    await mkdir(join(root, id))
    const file = join(root, id, 'workspace.yaml')
    await writeFile(file, yaml('First'))
    await utimes(file, 1000, 1000)
    const first = await readCopilotSessionName(root, id)
    assert.equal(first.value?.name, 'First')
    await writeFile(file, yaml('Second'))
    await utimes(file, 1000, 1000)
    assert.equal((await readCopilotSessionName(root, id, first)).value?.name, 'First', 'same mtime: the known value is kept')
    await utimes(file, 2000, 2000)
    assert.equal((await readCopilotSessionName(root, id, first)).value?.name, 'Second')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('the rename command is one bounded line', () => {
  assert.equal(renameCommand('Fix login'), '/rename Fix login')
  assert.equal(renameCommand('  two\nlines\r\x1b[31m  '), '/rename two lines [31m')
  assert.equal(renameCommand('x'.repeat(300)), `/rename ${'x'.repeat(120)}`)
  assert.equal(renameCommand(' \n '), null)
})

test('the prompt counts as empty only after Enter or Ctrl+C, and mouse or focus reports change nothing', () => {
  const draft = new PromptDraft()
  assert.equal(draft.empty, true, 'a new session starts with an empty prompt')
  draft.note('hello', 1000)
  assert.equal(draft.empty, false)
  draft.note('\x1b[<0;10;5M\x1b[<0;10;5m\x1b[I', 1100)
  assert.equal(draft.empty, false, 'clicks do not clear a draft')
  assert.equal(draft.quiet(2999), false, 'the last typed key counts, not the click')
  draft.note('\r', 1200)
  assert.equal(draft.empty, true)
  draft.note('\x1b[A', 1300)
  assert.equal(draft.empty, false, 'history recall puts text in the box')
  draft.note('\x03', 1400)
  assert.equal(draft.empty, true)
  draft.note('first line\x1b\r', 1500)
  assert.equal(draft.empty, false, 'Alt+Enter adds a line')
  draft.note('\x1b[200~pasted\r\x1b[201~', 1600)
  assert.equal(draft.empty, false)
  assert.equal(draft.quiet(3500), false)
  assert.equal(draft.quiet(3600), true)
  const picker = new PromptDraft({ awaitingFirstEnter: true })
  assert.equal(picker.empty, false, 'nothing is typed while the resume picker may be showing')
  picker.note('\r', 1000)
  assert.equal(picker.empty, true)
})

test('a tab follows Copilot\'s name until someone names it, and then Copilot is renamed to match', () => {
  const tab = { title: 'project', autoTitle: true, remote: false, lastSessionId: 'id' }
  assert.deepEqual(nameSyncAction(tab, undefined), { kind: 'none' }, 'nothing before the name is read')
  assert.deepEqual(nameSyncAction(tab, null), { kind: 'none' }, 'Copilot names it after the first prompt')
  assert.deepEqual(nameSyncAction(tab, { name: 'Say hello please', userNamed: false }), { kind: 'adopt', title: 'Say hello please' })
  assert.deepEqual(nameSyncAction({ ...tab, title: 'Say hello please' }, { name: 'Say hello please', userNamed: false }), { kind: 'none' })
  const named = { ...tab, autoTitle: false, renamePending: true, title: 'Fix login' }
  assert.deepEqual(nameSyncAction(named, { name: 'Say hello please', userNamed: false }), { kind: 'rename', title: 'Fix login' })
  assert.deepEqual(nameSyncAction(named, null), { kind: 'rename', title: 'Fix login' }, 'a session Copilot has not named yet')
  assert.deepEqual(nameSyncAction(named, { name: 'Fix login', userNamed: true }), { kind: 'confirmed' })
  assert.deepEqual(nameSyncAction({ ...named, remote: true }, null), { kind: 'none' })
  assert.deepEqual(nameSyncAction({ ...named, lastSessionId: null }, null), { kind: 'none' })
  // A tab saved by an older release, or named when it started: nothing is typed into it unasked.
  assert.deepEqual(nameSyncAction({ ...named, renamePending: false }, { name: 'Something else', userNamed: false }), { kind: 'none' })
})
