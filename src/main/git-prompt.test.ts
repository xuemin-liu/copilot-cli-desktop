import assert from 'node:assert/strict'
import test from 'node:test'
import { PROMPT_BUDGET, composeCommitMessagePrompt, composeDiffPrompt, composeGitCursorContext, composeResolvePullPrompt, composeReviewCommentsPrompt, fitLines, listNames, looksSensitivePath, maskSecrets, privateKeyLineRanges } from './git-prompt.js'
import type { DiffComment } from './git-prompt.js'
import type { GitDiffView } from './git-types.js'

const textDiff = (text: string, extra: Partial<GitDiffView> = {}): GitDiffView => ({ entryId: 'e1-0', path: 'a.ts', kind: 'text', text, truncated: false, added: 1, deleted: 0, ...extra })
const manyLines = (count: number): string => Array.from({ length: count }, (_item, index) => `+line ${index} ${'x'.repeat(40)}`).join('\n')

test('cursor context identifies the exact file, side and line with a bounded nearby excerpt', () => {
  const input = { folder: 'D:\\repo.worktrees\\one', path: 'src/a.ts', staged: true, side: 'old' as const, line: 42,
    order: 5, diffText: Array.from({ length: 15 }, (_, index) => `-${index} ${'x'.repeat(2_000)}`).join('\r\n') }
  const text = composeGitCursorContext(input)
  assert.match(text, /repo.worktrees/)
  assert.match(text, /src\/a.ts/)
  assert.match(text, /Change: staged\nCursor: old line 42/)
  assert.match(text, /> -5 /)
  assert.doesNotMatch(text, /-0 |\n  -9 /)
  assert.ok(text.length < 8_000)
})

test('cursor excerpts redact key bodies even when the BEGIN marker is outside the excerpt', () => {
  const input = { folder: 'D:\\repo', path: 'a.ts', staged: false, side: 'new' as const, line: 6, order: 6,
    diffText: ['@@ -0,0 +1,10 @@', '+-----BEGIN PRIVATE KEY-----', ...Array(6).fill('+PRIVATE-BODY'), '+-----END PRIVATE KEY-----', '+password: hunter2'].join('\n') }
  const text = composeGitCursorContext(input)
  assert.doesNotMatch(text, /PRIVATE-BODY|hunter2/)
  assert.match(text, /> \[REDACTED PRIVATE KEY\]/)
  assert.match(text, /Change: working tree/)
  const withheld = composeGitCursorContext({ ...input, path: '.env', diffText: '+secret value', order: 0 })
  assert.match(withheld, /contents withheld/)
  assert.doesNotMatch(withheld, /secret value/)
  assert.doesNotMatch(composeGitCursorContext({ ...input, diffText: '+safe\x1b[201~\x00', order: 0 }), /\x1b|\x00/)
})

test('secrets files are recognized by name, whatever the separators or case', () => {
  for (const path of ['.env', 'app/.env.local', 'config\\.env.production', 'certs/server.PEM', 'keys/id_rsa', 'a/b/secrets.json', 'credentials', 'deploy/.npmrc', 'x.pfx']) {
    assert.equal(looksSensitivePath(path), true, path)
  }
  for (const path of ['src/environment.ts', 'docs/keyboard.md', 'id_rsa.pub', 'src/secret-santa.ts', 'README.md', 'monkey.ts']) {
    assert.equal(looksSensitivePath(path), false, path)
  }
})

test('credential-looking values and private key blocks are masked', () => {
  const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----'
  const result = maskSecrets(`+API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\n+password: hunter2\n+url=https://user:pw@example.com/x\n${key}\n+harmless = 1`)
  assert.equal(result.masked, true)
  assert.doesNotMatch(result.text, /sk-abcdef|hunter2|user:pw|MIIBOgIB/)
  assert.match(result.text, /harmless = 1/)
  assert.match(result.text, /\[REDACTED PRIVATE KEY\]/)
  assert.deepEqual(maskSecrets('+const a = 1'), { text: '+const a = 1', masked: false })
})

test('fitLines keeps whole lines and counts what it dropped', () => {
  assert.deepEqual(fitLines('one\ntwo', 100), { text: 'one\ntwo', omittedLines: 0 })
  const fitted = fitLines('aaaa\nbbbb\ncccc\ndddd', 12)
  assert.deepEqual(fitted, { text: 'aaaa\nbbbb', omittedLines: 2 })
})

test('a small diff becomes a fenced block that names the file and side', () => {
  const prompt = composeDiffPrompt({ repoName: 'app', path: 'src/a.ts', staged: true, diff: textDiff('@@ -1 +1 @@\n-old\n+new') })
  assert.match(prompt, /^Here is the staged change to `src\/a\.ts` in `app`:/)
  assert.match(prompt, /```diff\n@@ -1 \+1 @@\n-old\n\+new\n```/)
  assert.doesNotMatch(prompt, /truncated/)
  assert.match(composeDiffPrompt({ repoName: 'app', path: 'a', staged: false, diff: textDiff('x') }), /unstaged change/)
})

test('a long diff stays inside the prompt budget with its marker intact', () => {
  const prompt = composeDiffPrompt({ repoName: 'app', path: 'big.ts', staged: false, diff: textDiff(manyLines(2_000)) })
  assert.ok(prompt.length <= PROMPT_BUDGET, `${prompt.length} > ${PROMPT_BUDGET}`)
  assert.match(prompt, /\[… diff truncated: \d+ more lines not shown\]/)
  assert.match(prompt, /```\n$/, 'the closing fence survives truncation')
})

test('a diff the panel itself had to cut is marked even when every kept line fits', () => {
  const prompt = composeDiffPrompt({ repoName: 'app', path: 'huge.ts', staged: false, diff: textDiff('+a\n+b', { truncated: true }) })
  assert.match(prompt, /larger than the panel reads/)
})

test('secrets files are named but their contents never leave the panel', () => {
  const prompt = composeDiffPrompt({ repoName: 'app', path: '.env', staged: false, diff: textDiff('+TOKEN=abc123') })
  assert.match(prompt, /contents withheld/)
  assert.doesNotMatch(prompt, /abc123/)
})

test('masked values are reported once in the prompt', () => {
  const prompt = composeDiffPrompt({ repoName: 'app', path: 'config.ts', staged: false, diff: textDiff('+password: hunter2') })
  assert.doesNotMatch(prompt, /hunter2/)
  assert.match(prompt, /replaced with \[REDACTED\]/)
})

test('binary, folder, oversized and empty entries are described, not dumped', () => {
  for (const [kind, pattern] of [['binary', /binary file/], ['directory', /untracked folder/], ['too-large', /too large/], ['empty', /no textual change/]] as const) {
    const prompt = composeDiffPrompt({ repoName: 'app', path: 'x', staged: false, diff: textDiff('', { kind }) })
    assert.match(prompt, pattern, kind)
  }
})

test('the commit-message prompt shares the budget between files and lists what it left out', () => {
  const parts = Array.from({ length: 40 }, (_item, index) => ({ path: `src/file-${index}.ts`, diff: textDiff(manyLines(60)) }))
  const prompt = composeCommitMessagePrompt({ repoName: 'app', branch: 'main', parts })
  assert.ok(prompt.length <= PROMPT_BUDGET, `${prompt.length} > ${PROMPT_BUDGET}`)
  assert.match(prompt, /^Write a concise conventional-commit message/)
  assert.match(prompt, /on branch `main`/)
  assert.match(prompt, /### src\/file-0\.ts/)
  assert.match(prompt, /\d+ more staged files not shown: src\/file-\d+\.ts/)
  const few = composeCommitMessagePrompt({ repoName: 'app', branch: null, parts: parts.slice(0, 2) })
  assert.doesNotMatch(few, /not shown: /)
  assert.doesNotMatch(few, /on branch/)
})

test('the commit-message prompt withholds secrets files and masks values in the others', () => {
  const prompt = composeCommitMessagePrompt({
    repoName: 'app', branch: 'dev',
    parts: [{ path: '.env.local', diff: textDiff('+SECRET=zzz') }, { path: 'src/a.ts', diff: textDiff('+token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"') }],
  })
  assert.doesNotMatch(prompt, /zzz|ghp_abcdef/)
  assert.match(prompt, /contents withheld/)
  assert.match(prompt, /replaced with \[REDACTED\]/)
})

test('listNames keeps whole names and counts what it left out', () => {
  assert.equal(listNames(['a.ts', 'b.ts'], 100), 'a.ts, b.ts')
  const many = Array.from({ length: 50 }, (_item, index) => `src/file-${index}.ts`)
  const listed = listNames(many, 100)
  assert.match(listed, /, and \d+ more$/)
  assert.ok(listed.length < 160)
  assert.equal(listNames([], 100), '')
})

test('staged files whose diffs were not read are still named and counted', () => {
  const read = Array.from({ length: 30 }, (_item, index) => ({ path: `extra-${index}.txt`, diff: textDiff(`+line ${index}`) }))
  const prompt = composeCommitMessagePrompt({ repoName: 'app', branch: 'main', parts: read, omitted: ['extra-30.txt'] })
  // The composer shows as many diffs as fit; every other file, including the one never read, is counted and named.
  const shown = (prompt.match(/^### /gm) ?? []).length
  const stated = Number(/(\d+) more staged files? not shown/.exec(prompt)?.[1])
  assert.equal(shown + stated, 31, `${shown} shown + ${stated} stated`)
  assert.ok(prompt.includes('extra-30.txt'), 'the last file appears in the prompt')
  assert.ok(prompt.length <= PROMPT_BUDGET)
})

test('the omitted count adds up whatever mix of budget cuts and unread files there is', () => {
  const read = Array.from({ length: 30 }, (_item, index) => ({ path: `big-${index}.txt`, diff: textDiff(manyLines(80)) }))
  const omitted = Array.from({ length: 17 }, (_item, index) => `unread-${index}.txt`)
  const prompt = composeCommitMessagePrompt({ repoName: 'app', branch: null, parts: read, omitted })
  const shown = (prompt.match(/^### /gm) ?? []).length
  const stated = Number(/(\d+) more staged files? not shown/.exec(prompt)?.[1])
  assert.equal(shown + stated, 47, `${shown} shown + ${stated} stated`)
  assert.ok(prompt.length <= PROMPT_BUDGET)
  assert.match(prompt, /unread-0\.txt/)
})

test('a very long list of unread files is counted exactly and still fits the budget', () => {
  const omitted = Array.from({ length: 400 }, (_item, index) => `generated/path/to/file-number-${index}.ts`)
  const prompt = composeCommitMessagePrompt({ repoName: 'app', branch: 'main', parts: [{ path: 'a.ts', diff: textDiff('+x') }], omitted })
  assert.match(prompt, /400 more staged files not shown: /)
  assert.match(prompt, /, and \d+ more\./)
  assert.ok(prompt.length <= PROMPT_BUDGET)
})

test('a cut-off status list is called out, because there may be staged files nobody saw', () => {
  const prompt = composeCommitMessagePrompt({ repoName: 'app', branch: 'main', parts: [{ path: 'a.ts', diff: textDiff('+x') }], listTruncated: true })
  assert.match(prompt, /status list was cut off/)
  assert.doesNotMatch(composeCommitMessagePrompt({ repoName: 'app', branch: 'main', parts: [{ path: 'a.ts', diff: textDiff('+x') }] }), /cut off/)
})

const comment = (line: number, text: string, extra: Partial<DiffComment> = {}): DiffComment => ({ side: 'new', line, index: line, quote: `+const value = ${line}`, redacted: false, text, ...extra })

test('review comments are numbered in order, name their line and side, and quote the diff line as inline code', () => {
  const result = composeReviewCommentsPrompt({ repoName: 'repo', path: 'src/a.ts', staged: false, comments: [
    comment(45, 'return a typed error object here too'),
    comment(12, 'drop this', { side: 'old', quote: '-old()' }),
    comment(52, 'first line\r\nsecond line\u0007 with a bell', { quote: '+has `tick`' }),
  ] })
  assert.equal(result.included, 3)
  assert.equal(result.quotesDropped, false)
  assert.equal(result.text,
    'Review comments on `src/a.ts` (unstaged change in `repo`). Please address each one:\n'
    + '1. Line 45 (`+const value = 45`):\n   return a typed error object here too\n'
    + '2. Old line 12 (`-old()`):\n   drop this\n'
    + '3. Line 52 ("+has `tick`"):\n   first line\n   second line with a bell\n')
  assert.match(composeReviewCommentsPrompt({ repoName: 'r', path: 'a', staged: true, comments: [comment(1, '   ')] }).text, /staged change[\s\S]*\(empty comment\)/)
})

test('review comments on a secrets file keep the comments but never quote the lines, and masked values are reported', () => {
  const secret = composeReviewCommentsPrompt({ repoName: 'repo', path: 'config/.env.production', staged: false, comments: [comment(3, 'rotate this', { quote: '+API_KEY=sk-abcdefghijklmnopqrstuvwxyz' })] })
  assert.doesNotMatch(secret.text, /sk-abcdefghijklmnopqrstuvwxyz|API_KEY/)
  assert.match(secret.text, /1\. Line 3:\n   rotate this\n/)
  assert.match(secret.text, /not quoted because this file looks like it holds secrets/)
  assert.equal(secret.quotesDropped, false)
  const masked = composeReviewCommentsPrompt({ repoName: 'repo', path: 'src/client.ts', staged: false, comments: [comment(8, 'move to the vault', { quote: '+const token = "ghp_abcdefghijklmnopqrstuvwxyz0123"' })] })
  assert.doesNotMatch(masked.text, /ghp_abcdefghijklmnopqrstuvwxyz0123/)
  assert.match(masked.text, /\[REDACTED\]/)
  assert.match(masked.text, /looked like credentials were replaced/)
})

test('review comments stay inside the budget by dropping the quotes first, then trailing comments, and say so', () => {
  const long = (count: number): DiffComment[] => Array.from({ length: count }, (_item, index) => comment(index + 1, `comment ${index}`, { quote: `+${'q'.repeat(190)}` }))
  const quotesOnly = composeReviewCommentsPrompt({ repoName: 'r', path: 'a.ts', staged: false, comments: long(60) })
  assert.ok(quotesOnly.text.length <= PROMPT_BUDGET)
  assert.equal(quotesOnly.included, 60, 'dropping the quotes was enough')
  assert.equal(quotesOnly.quotesDropped, true)
  assert.doesNotMatch(quotesOnly.text, /qqqq/)
  assert.doesNotMatch(quotesOnly.text, /not included/)
  const many = composeReviewCommentsPrompt({ repoName: 'r', path: 'a.ts', staged: false, comments: Array.from({ length: 400 }, (_item, index) => comment(index + 1, `c${index} ${'x'.repeat(100)}`)) })
  assert.ok(many.text.length <= PROMPT_BUDGET)
  assert.ok(many.included > 0 && many.included < 400)
  assert.match(many.text, new RegExp(`\\[… ${400 - many.included} more comments not included: the prompt box is full\\]`))
  assert.match(many.text, new RegExp(`${many.included}\\. Line ${many.included}:`))
  assert.doesNotMatch(many.text, new RegExp(`${many.included + 1}\\. Line`))
  const huge = composeReviewCommentsPrompt({ repoName: 'r', path: 'a.ts', staged: false, comments: [comment(1, 'y'.repeat(50_000)), comment(2, 'short')] })
  assert.ok(huge.text.length <= PROMPT_BUDGET)
  assert.equal(huge.included, 2, 'a single comment is cut to its own bound, not dropped')
})

test('private-key block ranges are found in a diff, and a comment captured inside one is never quoted', () => {
  const diffText = [
    '@@ -1,2 +1,6 @@', ' before', '+-----BEGIN RSA PRIVATE KEY-----', '+MIIEowIBAAKCAQEAu7secretsecretsecret', '+zzzzsecretsecretsecretsecretsecret', '+-----END RSA PRIVATE KEY-----', ' after',
  ].join('\n') + '\n'
  assert.deepEqual(privateKeyLineRanges(diffText), [[2, 5]])
  assert.deepEqual(privateKeyLineRanges('@@ -1 +1 @@\n+-----BEGIN PRIVATE KEY-----\n+unterminated'), [[1, 2]], 'an unterminated block runs to the end')
  assert.deepEqual(privateKeyLineRanges('@@ -1 +1 @@\n+harmless'), [])
  const result = composeReviewCommentsPrompt({ repoName: 'r', path: 'config.txt', staged: false, comments: [
    { side: 'new', line: 3, index: 3, quote: '', redacted: true, text: 'rotate this key' },
    { side: 'new', line: 6, index: 6, quote: ' after', redacted: false, text: 'and this is fine to quote' },
  ] })
  assert.doesNotMatch(result.text, /MIIEow|secretsecret/)
  assert.match(result.text, /1\. Line 3 \(`\[REDACTED PRIVATE KEY\]`\):\n   rotate this key\n/)
  assert.match(result.text, /2\. Line 6 \(` after`\):\n   and this is fine to quote\n/)
  assert.match(result.text, /looked like credentials were replaced/)
  const unflagged = composeReviewCommentsPrompt({ repoName: 'r', path: 'config.txt', staged: false, comments: [
    { side: 'new', line: 3, index: 3, quote: '+MIIEowIBAAKCAQEAu7secretsecretsecret', redacted: false, text: 'rotate this key' },
  ] })
  assert.match(unflagged.text, /MIIEow/, 'the composer trusts the flag: redaction is decided where the quote is captured (diff-comments.ts)')
})

const resolveInput = { repoName: 'app', folder: 'D:\\work\\app', branch: 'main', upstream: 'origin/main', ahead: 2, behind: 3, output: '', blocked: [] as string[], conflicted: [] as string[] }

test('the resolve prompt names the folder and the branches, and rules out what loses work', () => {
  const text = composeResolvePullPrompt({ ...resolveInput, situation: 'diverged', output: 'fatal: Not possible to fast-forward, aborting.' })
  assert.match(text, /`app` at `D:\\work\\app`/)
  assert.match(text, /`main` could not be fast-forwarded to `origin\/main` because both have new commits \(2 local commits not on `origin\/main`, 3 new commits on it\)/)
  assert.match(text, /Pull `origin\/main` into `main` with a merge\./)
  assert.match(text, /Do not rebase, force, `git reset --hard`, discard changes, or push\./)
  assert.match(text, /stop and ask me before stashing, committing or discarding/)
  assert.match(text, /Commit the merge/)
  assert.match(text, /What Git printed:\n```text\nfatal: Not possible to fast-forward, aborting\.\n```/)
  assert.ok(text.length < PROMPT_BUDGET)
})

test('the resolve prompt for local changes names the files in the way; for a stopped merge it finishes that merge', () => {
  const blocked = composeResolvePullPrompt({ ...resolveInput, situation: 'local-changes', blocked: ['src/a.ts', 'b.txt'], output: 'error: Your local changes …' })
  assert.match(blocked, /failed because uncommitted changes would be overwritten/)
  assert.match(blocked, /Files in the way: src\/a\.ts, b\.txt\./)
  const stopped = composeResolvePullPrompt({ ...resolveInput, situation: 'conflicts', upstream: null, ahead: 0, behind: 0, conflicted: ['x.ts'] })
  assert.match(stopped, /a merge into `main` has stopped on conflicts/)
  assert.match(stopped, /Finish the merge that is in progress/)
  assert.doesNotMatch(stopped, /Pull .* with a merge/)
  assert.match(stopped, /Conflicted files: x\.ts\./)
  assert.doesNotMatch(stopped, /What Git printed/, 'no pull ran, so there is no output section')
})

test('the resolve prompt stays inside the budget, masks credentials and cannot be closed by backticks in the output', () => {
  const output = ['To https://user:hunter2secret@example.org/r.git', '````', ...Array.from({ length: 2_000 }, (_item, index) => `line ${index} ${'x'.repeat(40)}`)].join('\n')
  const many = Array.from({ length: 5_000 }, (_item, index) => `src/file-${index}.ts`)
  const text = composeResolvePullPrompt({ ...resolveInput, situation: 'diverged', output, conflicted: many, blocked: many })
  assert.ok(text.length < PROMPT_BUDGET, `${text.length}`)
  assert.equal(text.includes('hunter2secret'), false)
  assert.match(text, /What Git printed:\n`````text\n/, 'a fence longer than the four backticks inside')
  assert.match(text, /more lines not shown\]/)
  assert.match(text, /Conflicted files: .*, and \d+ more\./)
})
