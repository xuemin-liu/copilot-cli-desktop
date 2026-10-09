import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_REVIEW_VALUE_CHARS, formatReviewText, isReviewable } from './git-review-format.js'

test('ordinary settings read exactly as they are', () => {
  for (const text of ['git-lfs clean -- %f', 'ssh -i C:\\Users\\a\\.ssh\\id -o BatchMode=yes', 'core.sshcommand', 'a  b   c']) {
    assert.equal(formatReviewText(text), text)
  }
})

test('a long run of spaces is spelled out, so a command pushed out of sight is visible', () => {
  const payload = `cat${' '.repeat(220)}; echo HIDDEN-COMMAND > review-marker.txt`
  const shown = formatReviewText(payload)
  assert.match(shown, /^cat⟦220 spaces⟧; echo HIDDEN-COMMAND > review-marker\.txt$/)
  assert.ok(shown.includes('HIDDEN-COMMAND'))
  assert.equal(formatReviewText('a    b'), 'a⟦4 spaces⟧b', 'four is the first run that is spelled out')
})

test('line breaks and tabs are shown, not rendered', () => {
  assert.equal(formatReviewText('ssh\nfilter.evil.clean=cmd'), 'ssh⟦newline⟧filter.evil.clean=cmd')
  assert.equal(formatReviewText('a\tb\rc'), 'a⟦tab⟧b⟦return⟧c')
})

test('characters with no visible form are named by code point', () => {
  assert.equal(formatReviewText('a\u200bb'), 'a⟦U+200B⟧b', 'zero-width space')
  assert.equal(formatReviewText('a\u202eb'), 'a⟦U+202E⟧b', 'right-to-left override')
  assert.equal(formatReviewText('a\u00a0b'), 'a⟦U+00A0⟧b', 'non-breaking space')
  assert.equal(formatReviewText('a\u0000b\u001bc'), 'a⟦U+0000⟧b⟦U+001B⟧c', 'control characters')
  assert.equal(formatReviewText('a\ufeffb'), 'a⟦U+FEFF⟧b', 'byte-order mark')
  assert.equal(formatReviewText('café 名前'), 'café 名前', 'ordinary non-ASCII text is untouched')
})

test('only settings short enough to show in full can be reviewed', () => {
  assert.equal(isReviewable([{ key: 'core.sshcommand', value: 'x'.repeat(MAX_REVIEW_VALUE_CHARS) }]), true)
  assert.equal(isReviewable([{ key: 'core.sshcommand', value: 'x'.repeat(MAX_REVIEW_VALUE_CHARS + 1) }]), false)
  assert.equal(isReviewable([{ key: 'a', value: 'b' }, { key: 'c', value: 'y'.repeat(MAX_REVIEW_VALUE_CHARS + 1) }]), false)
  assert.equal(isReviewable([]), true)
})
