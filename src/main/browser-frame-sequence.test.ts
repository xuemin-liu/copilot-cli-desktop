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

test('frameCommitted holds only while the viewport is settled on the expected frame', () => {
  const events = stream(), want = { viewport: 'v1', epoch: 'series1', frame: 42 }
  assert.match(events.committed(want, 0).reason!, /no frame request/)
  emit(events, 'request', 7, 41, 0); emit(events, 'request', 8, 42, 1)
  assert.match(events.committed(want, 0).reason!, /not committed/)
  emit(events, 'commit', 8, 42, 5)
  const settled = events.committed(want, 0)
  assert.ok(settled.passed)
  assert.deepEqual([settled.data.frameCommitted.revision, settled.data.frameCommitted.requestToCommitMs, settled.data.frameCommitted.supersededRequests], [8, 4, 1])
  assert.match(events.committed({ ...want, frame: 41 }, 0).reason!, /frame 42/)
  // Evidence before the window does not count: the request must be seen after the mark.
  assert.match(events.committed(want, events.mark()).reason!, /no frame request/)
  // The superseded request commits late and overwrites the image.
  emit(events, 'commit', 7, 41, 6)
  assert.match(events.committed(want, 0).reason!, /stale commit \(frame 41\)/)
  // A newer request for the same frame is not ready until it commits.
  emit(events, 'request', 9, 42, 7)
  assert.match(events.committed(want, 0).reason!, /not committed/)
  emit(events, 'commit', 9, 42, 8)
  assert.ok(events.committed(want, 0).passed)
})

test('frameCommitted rejects other epochs, broken identity and incomplete evidence', () => {
  const want = { viewport: 'v1', epoch: 'series1', frame: 2 }
  const ready = () => { const events = stream(); emit(events, 'request', 1, 2, 0); emit(events, 'commit', 1, 2, 1); return events }
  let events = ready()
  emit(events, 'request', 1, 9, 2, 2, { epoch: 'series2' })
  assert.match(events.committed(want, 0).reason!, /another epoch/)
  // An old-epoch commit cannot restore readiness after a new-epoch request, and a new-epoch commit ends the old epoch's.
  emit(events, 'commit', 1, 2, 3)
  assert.equal(events.committed(want, 0).passed, false)
  events = ready(); emit(events, 'commit', 5, 2, 2, 2, { epoch: 'series2' })
  assert.match(events.committed(want, 0).reason!, /Another epoch committed/)
  events = ready(); emit(events, 'commit', 1, 2, 2)
  assert.match(events.committed(want, 0).reason!, /more than once/)
  events = stream(); emit(events, 'request', 3, 1, 0); emit(events, 'request', 2, 2, 1); emit(events, 'commit', 2, 2, 2)
  assert.match(events.committed(want, 0).reason!, /strictly increasing/)
  events = stream(); emit(events, 'request', 1, 2, 0); emit(events, 'commit', 1, 3, 1)
  assert.match(events.committed(want, 0).reason!, /does not match/)
  // Another viewport's events are independent; a malformed event fails closed until the window starts after it.
  events = ready(); emit(events, 'request', 4, 7, 2, 2, { viewport: 'v2' })
  assert.ok(events.committed(want, 0).passed)
  events.add(FRAME_EVENT_PREFIX + '{bad')
  assert.match(events.committed(want, 0).reason!, /incomplete or malformed/)
  const mark = events.mark(); emit(events, 'request', 2, 2, 3); emit(events, 'commit', 2, 2, 4)
  assert.ok(events.committed(want, mark).passed)
})

test('frameCommitted plans validate the frame, the earlier step and where the condition may appear', () => {
  const commit = { viewport: 'v1', epoch: 'series1', frame: 42 }
  const plan = (...steps: unknown[]) => validateBrowserTestPlan({ description: 'Viewer', expected: 'Correct', steps: [{ action: 'click', selector: '#start' }, ...steps] })
  assert.ok(plan({ action: 'assert', condition: 'frameCommitted', commit }))
  assert.ok(plan({ action: 'waitFor', condition: 'frameCommitted', commit: { ...commit, since: 1 } }, { action: 'assert', all: [{ condition: 'frameCommitted', commit: { ...commit, since: 2 } }] }))
  for (const bad of [{ ...commit, since: 2 }, { ...commit, since: 0 }, { ...commit, frame: -1 }, { ...commit, frame: 1.5 }, { ...commit, viewport: 'patient/name' }, { ...commit, revision: 1 }, { viewport: 'v1', epoch: 'series1' }]) {
    assert.throws(() => plan({ action: 'assert', condition: 'frameCommitted', commit: bad }))
    assert.throws(() => plan({ action: 'assert', all: [{ condition: 'frameCommitted', commit: bad }] }))
  }
  assert.throws(() => plan({ action: 'assert', condition: 'frameCommitted' }))
  assert.throws(() => plan({ action: 'assert', condition: 'frameCommitted', commit, selector: '#viewport-1' }))
  assert.throws(() => plan({ action: 'assert', condition: 'frameCommitted', commit, expected: 'x' }))
  assert.throws(() => plan({ action: 'assert', selector: '#a', condition: 'visible', commit }))
  assert.throws(() => plan({ action: 'measure', name: 'slice', from: { step: 1 }, to: { condition: 'frameCommitted', commit }, maxMs: 100 }))
})
