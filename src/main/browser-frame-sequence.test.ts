import assert from 'node:assert/strict'
import test from 'node:test'
import { FrameEvents, FRAME_EVENT_PREFIX, type FrameEvent } from './browser-frame-sequence.js'
import { validateBrowserTestPlan } from './browser-test-plan.js'

const spec = { viewport: 'v1', epoch: 'series1', since: 1 }
const stream = () => new FrameEvents([spec])
const emit = (events: FrameEvents, type: FrameEvent['type'], revision: number, frame: number, timeMs: number, arrival = timeMs, extra = {}) =>
  events.add(FRAME_EVENT_PREFIX + JSON.stringify({ version: 1, type, viewport: 'v1', epoch: 'series1', revision, frame, timeMs, ...extra }), arrival)

test('committed frames have request correlation, latency and interval distributions', () => {
  const events = stream()
  for (let i = 0; i < 3; i++) { emit(events, 'request', i, i, i * 40); emit(events, 'commit', i, i, i * 40 + 10) }
  const result = events.analyze({ ...spec, minFrames: 3, order: 'ascending', maxSkipped: 0, maxRepeats: 0, maxLatencyMs: 10, maxStallMs: 40 }, 0, 0, 100)
  assert.ok(result.passed, result.reason)
  assert.equal(result.data.frameSequence.requestToCommitMs?.max, 10)
  assert.equal(result.data.frameSequence.intervalMs?.p95, 40)
  assert.equal(result.data.frameSequence.longestSilenceMs, 40)
})

test('transient stale commits fail even if a later commit corrects the image', () => {
  const events = stream()
  emit(events, 'request', 1, 1, 0); emit(events, 'request', 2, 2, 1); emit(events, 'commit', 2, 2, 2)
  emit(events, 'commit', 1, 1, 3); emit(events, 'request', 3, 2, 4); emit(events, 'commit', 3, 2, 5)
  assert.equal(events.analyze(spec, 0, 0, 6).data.frameSequence.staleCommits, 1)
  assert.equal(events.analyze(spec, 0, 0, 6).passed, false)
})

test('wrong frame identity, duplicates, clocks, stalls and sequence gaps are independent failures', () => {
  const events = stream()
  emit(events, 'request', 1, 0, 0); emit(events, 'commit', 1, 1, 4)
  emit(events, 'commit', 1, 1, 3); emit(events, 'request', 2, 5, 5); emit(events, 'commit', 2, 5, 15)
  const result = events.analyze({ ...spec, order: 'ascending', maxSkipped: 0, maxRepeats: 0, maxStallMs: 20, maxLatencyMs: 2 }, 0, 0, 100)
  assert.equal(result.passed, false)
  assert.equal(result.data.frameSequence.unmatchedCommits, 2)
  assert.equal(result.data.frameSequence.duplicateCommits, 1)
  assert.equal(result.data.frameSequence.clockErrors, 1)
  assert.equal(result.data.frameSequence.skippedFrames, 3)
  assert.match(result.reason, /silence.*latency/)
})

test('epochs, mark boundaries, descending wrap and complete bounded evidence', () => {
  const events = stream(); emit(events, 'commit', 0, 0, 0)
  const mark = events.mark()
  emit(events, 'request', 1, 0, 1); emit(events, 'commit', 1, 0, 2)
  emit(events, 'request', 2, 9, 3); emit(events, 'commit', 2, 9, 4)
  emit(events, 'commit', 1, 1, 0, 5, { viewport: 'other' })
  assert.ok(events.analyze({ ...spec, order: 'descending', wrapAt: 9, maxSkipped: 0 }, mark, 1, 5).passed)
  emit(events, 'commit', 1, 1, 5, 6, { epoch: 'old-series' })
  assert.equal(events.analyze(spec, mark, 1, 6).data.frameSequence.wrongEpochCommits, 1)
  events.add(FRAME_EVENT_PREFIX + '{bad')
  assert.equal(events.analyze(spec, mark, 1).data.frameSequence.complete, false)
  const overflow = stream()
  for (let i = 0; i < 5001; i++) emit(overflow, 'request', i, 0, i)
  assert.equal(overflow.analyze(spec, 0, 0).data.frameSequence.overflow, true)
  assert.equal(overflow.analyze(spec, overflow.mark(), 0).passed, false)
})

test('new test operations reject unbounded schemas and have real assertions', () => {
  const plan = (step: unknown, extra = {}) => validateBrowserTestPlan({ description: 'Viewer', expected: 'Correct', steps: [{ action: 'click', selector: '#start' }, step], ...extra })
  assert.ok(plan({ action: 'frameSequence', sequence: spec }))
  for (const sequence of [{ ...spec, since: 2 }, { ...spec, epoch: 'patient/name' }, { ...spec, maxSkipped: 0 }, { ...spec, script: 'run()' }]) assert.throws(() => plan({ action: 'frameSequence', sequence }))
  assert.ok(plan({ action: 'assertMeasurement', selector: '#probe', unit: 'HU', expected: 0, tolerance: 1 }, { viewport: { width: 640, height: 480, dpr: 2 } }))
  for (const viewport of [{ width: 900, height: 600, dpr: 2 }, { width: 640, height: 480, dpr: 0 }, { width: 641, height: 480, dpr: .5 }]) assert.throws(() => plan({ action: 'frameSequence', sequence: spec }, { viewport }))
  assert.throws(() => plan({ action: 'assertMeasurement', selector: '#probe', unit: 'pixels', expected: 1 }))
  assert.throws(() => plan({ action: 'sampleMetrics', selector: '#cache', samples: [{ name: 'bytes', attribute: 'data-bytes', unit: 'bytes', maxGrowth: 1 }] }))
})
