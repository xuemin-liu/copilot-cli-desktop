import assert from 'node:assert/strict'
import test from 'node:test'
import { PROMPT_BUDGET, composeCommitMessagePrompt, composeDiffPrompt, fitLines, looksSensitivePath, maskSecrets } from './git-prompt.js'
import type { GitDiffView } from './git-types.js'

const textDiff = (text: string, extra: Partial<GitDiffView> = {}): GitDiffView => ({ entryId: 'e1-0', path: 'a.ts', kind: 'text', text, truncated: false, added: 1, deleted: 0, ...extra })
const manyLines = (count: number): string => Array.from({ length: count }, (_item, index) => `+line ${index} ${'x'.repeat(40)}`).join('\n')

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
