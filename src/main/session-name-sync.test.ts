import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PromptDraft, nameSyncAction, parseWorkspaceName, readCopilotSessionName, renameCommand } from './session-name-sync.js'

const yaml = (name: string, userNamed = false): string =>
  `id: 11111111-1111-4111-8111-111111111111\ncwd: D:\\work\nname: ${name}\nuser_named: ${userNamed}\nsummary_count: 0\n`

test('cursor context attaches only to an ordinary draft with a known insertion point', () => {
  const draft = new PromptDraft()
  assert.equal(draft.canAttachContext, false)
  for (const char of 'why is this code needed?') draft.note(char)
  assert.equal(draft.canAttachContext, true)
  draft.note('\x1b[<0;4;8M')
  assert.equal(draft.canAttachContext, true, 'terminal mouse reports do not edit the prompt')
  draft.note('\x7f')
  draft.note('?')
  assert.equal(draft.canAttachContext, true)
  draft.note('\r')
  assert.equal(draft.canAttachContext, false)
  for (const command of ['/help', '  /rename name', '!git status', ' \t']) {
    draft.note(command)
    assert.equal(draft.canAttachContext, false, command)
    draft.note('\x03')
  }
  draft.note('\x1b[200~why is this\nneeded?\x1b[201~')
  assert.equal(draft.canAttachContext, true, 'multiline paste is a draft, not a submission')
  draft.note('\x1b\r')
  draft.note('explain')
  assert.equal(draft.canAttachContext, true, 'Alt+Enter continues the question')
  draft.note('\x1b[D')
  assert.equal(draft.canAttachContext, false, 'do not insert into the middle of an edited draft')
  draft.note('\r')
  draft.note('fresh question')
  assert.equal(draft.canAttachContext, true)
  draft.note('\t')
  assert.equal(draft.canAttachContext, false, 'autocomplete may change the draft')
  const picker = new PromptDraft({ awaitingFirstEnter: true })
  picker.note('search text')
  assert.equal(picker.canAttachContext, false)
  picker.note('\r')
  picker.note('question')
  assert.equal(picker.canAttachContext, true)
})

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

test('the terminal\'s answers to the CLI\'s queries are not typing, so a session nobody typed in stays empty', () => {
  const draft = new PromptDraft()
  // As seen when a restored session's terminal attaches: focus, the 16-colour palette, then focus out.
  draft.note('\x1b[I', 1000)
  for (let index = 0; index < 16; index++) draft.note(`\x1b]4;${index};rgb:2e2e/3434/3636\x1b\\`, 1000 + index)
  draft.note('\x1b]11;rgb:0000/0000/0000\x07\x1b[24;80R\x1b[?1;2c\x1b[>0;276;0c\x1b[?2004;1$y\x1b[0n\x1b[O', 1100)
  assert.equal(draft.empty, true)
  assert.equal(draft.quiet(2_000), true, 'no key was pressed: the replies did not reset the quiet time')
  draft.note('\x1b[A', 2000)
  assert.equal(draft.empty, false, 'a key that recalls history still counts')
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

test('keys that add nothing leave the prompt empty, and text typed then deleted is gone', () => {
  for (const key of ['\x1b', '\x1b[C', '\x1b[D', '\x1b[H', '\x1b[F', '\x1b[5~', '\x1b[6~', '\x1bOD', '\x1b[1;5D']) {
    const draft = new PromptDraft()
    draft.note(key, 1000)
    assert.equal(draft.empty, true, JSON.stringify(key))
    assert.equal(draft.quiet(1500), false, 'it still counts as the person being at the keyboard')
  }
  const deleted = new PromptDraft()
  deleted.note('a', 1000); deleted.note('b', 1001); deleted.note('c', 1002)
  assert.equal(deleted.empty, false)
  deleted.note('\x7f', 1003); deleted.note('\x7f', 1004)
  assert.equal(deleted.empty, false, 'one character is still there')
  deleted.note('\x7f', 1005)
  assert.equal(deleted.empty, true)
  const pasted = new PromptDraft()
  pasted.note('\x1b[200~pasted\x1b[201~', 1000)
  assert.equal(pasted.typed, true)
})

test('a paste or Ctrl+U never proves the box empty, so what is left of a draft is not submitted with an automatic message', () => {
  const lines = new PromptDraft()
  lines.note('\x1b[200~KEEP THIS LINE\nremove this line\x1b[201~', 1000)
  lines.note('\x15', 1001)
  assert.equal(lines.typed, true, 'Ctrl+U clears only the line the caret is on')
  for (let index = 0; index < 500; index++) lines.note('\x7f', 1002)
  assert.equal(lines.typed, true, 'a pasted length is not followed, whatever is deleted after it')

  const wrapped = new PromptDraft()
  wrapped.note('a long line of typed words that may wrap on screen', 1000)
  wrapped.note('\x15', 1001)
  assert.equal(wrapped.typed, true, 'it may clear only what shows on one row')
  for (let index = 0; index < 500; index++) wrapped.note('\x7f', 1002)
  assert.equal(wrapped.typed, true)

  const onlyPaste = new PromptDraft()
  onlyPaste.note('\x1b[200~one line\x1b[201~', 1000)
  for (let index = 0; index < 500; index++) onlyPaste.note('\x7f', 1001)
  assert.equal(onlyPaste.typed, true)
  onlyPaste.note('\x03', 1002)
  assert.equal(onlyPaste.empty, true, 'Ctrl+C clears the whole box')

  const sent = new PromptDraft()
  sent.note('\x1b[200~the desktop\'s own message\x1b[201~', 1000)
  sent.note('\r', 1300)
  assert.equal(sent.empty, true, 'Enter submits it, so a typed delivery leaves the box empty')
})

test('what may hold the person\'s own words is never taken for empty, and only a recalled prompt can be cleared for them', () => {
  const recalled = new PromptDraft()
  recalled.note('\x1b[A', 1000)
  assert.deepEqual([recalled.empty, recalled.recalled, recalled.typed], [false, true, false])
  recalled.note('\x1b[B', 1001)
  assert.equal(recalled.recalled, true, 'Down may still show a recalled prompt')
  recalled.note('!', 1002)
  assert.deepEqual([recalled.empty, recalled.recalled, recalled.typed], [false, false, true], 'editing it makes it their own')
  recalled.note('\x7f', 1003)
  assert.equal(recalled.typed, true, 'its length is not known, so deleting cannot prove it empty')

  const caret = new PromptDraft()
  caret.note('abc', 1000); caret.note('\x1b[D', 1001); caret.note('\x7f', 1002); caret.note('\x7f', 1003); caret.note('\x7f', 1004)
  assert.equal(caret.typed, true, 'after moving the caret, Backspace may have deleted less than it seems')
  const up = new PromptDraft()
  up.note('abc', 1000); up.note('\x1b[A', 1001); up.note('\x7f', 1002); up.note('\x7f', 1003); up.note('\x7f', 1004)
  assert.equal(up.typed, true, 'Up may move within a draft of several lines')
  for (const key of ['\t', '\x17', '\x16', '\x1b[3~', '\x1b[2~', '\x1bv', '\x1b[1;2A']) {
    const unknown = new PromptDraft()
    unknown.note(key, 1000)
    assert.equal(unknown.typed, true, `${JSON.stringify(key)} is not known to add nothing`)
    unknown.note('\x7f', 1001)
    assert.equal(unknown.typed, true, 'and nothing proves it empty but Enter or Ctrl+C')
    unknown.note('\x03', 1002)
    assert.equal(unknown.empty, true)
  }
  const line = new PromptDraft()
  line.note('first\x1b\r', 1000); line.note('\x15', 1001)
  assert.equal(line.typed, true, 'Ctrl+U clears one line of several')
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
