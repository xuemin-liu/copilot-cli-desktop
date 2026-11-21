import assert from 'node:assert/strict'
import test from 'node:test'
import { SOURCE_LINE_LIMIT, sourceWindow } from '../renderer/file-source-lines.js'

test('a file that fits is drawn whole, with nothing to say', () => {
  assert.deepEqual(sourceWindow(0), { start: 0, end: 0, note: null })
  assert.deepEqual(sourceWindow(SOURCE_LINE_LIMIT), { start: 0, end: SOURCE_LINE_LIMIT, note: null })
  assert.deepEqual(sourceWindow(1_200, 900), { start: 0, end: 1_200, note: null })
})

test('a longer file is drawn from the top, and says which lines are shown', () => {
  const shown = sourceWindow(SOURCE_LINE_LIMIT + 1)
  assert.deepEqual([shown.start, shown.end], [0, SOURCE_LINE_LIMIT])
  assert.equal(shown.note, 'Showing lines 1 to 20,000 of 20,001. The file is too long to show all at once; open it in an editor to see the rest.')
  assert.equal(sourceWindow(2_000_000).end - sourceWindow(2_000_000).start, SOURCE_LINE_LIMIT)
})

test('a link to a line far down draws the lines around it, within the file', () => {
  const total = 500_000
  const middle = sourceWindow(total, 150_000)
  assert.deepEqual([middle.start, middle.end], [139_999, 159_999])
  assert.ok(middle.start < 150_000 - 1 && 150_000 - 1 < middle.end, 'the line itself is drawn')
  assert.match(middle.note ?? '', /^Showing lines 140,000 to 159,999 of 500,000\./)
  const last = sourceWindow(total, total)
  assert.deepEqual([last.start, last.end], [total - SOURCE_LINE_LIMIT, total])
  assert.deepEqual([sourceWindow(total, 5).start, sourceWindow(total, 5).end], [0, SOURCE_LINE_LIMIT])
  // A line that is not in the file, or not a line number, is no reason to move.
  for (const odd of [0, -4, total + 1, 2.5, Number.NaN]) assert.equal(sourceWindow(total, odd).start, 0, String(odd))
})

test('the limit can be set, for a caller with other needs', () => {
  assert.deepEqual(sourceWindow(10, 9, 4), { start: 6, end: 10, note: 'Showing lines 7 to 10 of 10. The file is too long to show all at once; open it in an editor to see the rest.' })
})
