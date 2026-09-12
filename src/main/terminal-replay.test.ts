import assert from 'node:assert/strict'
import test from 'node:test'
import { TerminalReplay } from '../renderer/terminal-replay.js'

test('snapshot and output racing across a window move render each byte once', () => {
  const history: string[] = []
  const live: string[] = []
  const replay = new TerminalReplay(data => history.push(data), data => live.push(data))
  // The first chunk is already part of the snapshot by the time main handles
  // the request; the second arrives while its response is in flight.
  replay.push({ data: 'saved marker', sequence: 4 })
  replay.push({ data: 'next reply', sequence: 5 })
  replay.restore({ data: 'earlier text\nsaved marker', sequence: 4 })
  replay.push({ data: 'saved marker', sequence: 4 })
  replay.push({ data: 'next reply', sequence: 5 })
  replay.push({ data: 'final reply', sequence: 6 })
  assert.deepEqual(history, ['earlier text\nsaved marker'])
  assert.deepEqual(live, ['next reply', 'final reply'])
})

test('empty snapshots release pending live output and ignore repeated restore', () => {
  const output: string[] = []
  const replay = new TerminalReplay(data => output.push(data), data => output.push(data))
  replay.push({ data: 'first prompt', sequence: 1 })
  replay.restore({ data: '', sequence: 0 })
  replay.restore({ data: 'stale history', sequence: 0 })
  assert.deepEqual(output, ['first prompt'])
})

test('a terminal closed before its snapshot arrives cannot write to the disposed renderer', () => {
  const output: string[] = []
  const replay = new TerminalReplay(data => output.push(data), data => output.push(data))
  replay.push({ data: 'pending output', sequence: 2 })
  replay.dispose()
  replay.restore({ data: 'late history', sequence: 1 })
  replay.push({ data: 'late live output', sequence: 3 })
  assert.deepEqual(output, [])
})
