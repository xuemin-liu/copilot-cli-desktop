import assert from 'node:assert/strict'
import test from 'node:test'
import { matchesSearch, searchHits, searchTerms } from '../renderer/settings-search.js'

test('settings search splits the query into lower-cased words', () => {
  assert.deepEqual(searchTerms('  Worktree   TIMEOUT '), ['worktree', 'timeout'])
  assert.deepEqual(searchTerms('   '), [])
})

test('settings search matches text containing every word in any order', () => {
  const text = 'When the main window closes: Ask every time, Minimize to tray, Exit the application'
  assert.equal(matchesSearch(text, searchTerms('tray close')), true)
  assert.equal(matchesSearch(text, searchTerms('TRAY')), true)
  assert.equal(matchesSearch(text, searchTerms('tray proxy')), false)
  assert.equal(matchesSearch(text, []), true)
})

test('settings search finds every occurrence of each word for highlighting', () => {
  assert.deepEqual(searchHits('Worktree timeout. A worktree', ['worktree']), [{ start: 0, end: 8 }, { start: 20, end: 28 }])
  assert.deepEqual(searchHits('Meeting round limit', ['round', 'limit']), [{ start: 8, end: 13 }, { start: 14, end: 19 }])
  assert.deepEqual(searchHits('Nothing here', ['tray']), [])
})
