import assert from 'node:assert/strict'
import test from 'node:test'
import { nextZoomFactor } from './browser-zoom.js'

test('zoom moves one Chrome step at a time, stops at the ends and resets to 100%', () => {
  assert.equal(nextZoomFactor(1, 'in'), 1.1)
  assert.equal(nextZoomFactor(1, 'out'), 0.9)
  assert.equal(nextZoomFactor(1.5, 'in'), 1.75)
  assert.equal(nextZoomFactor(0.25, 'out'), 0.25)
  assert.equal(nextZoomFactor(5, 'in'), 5)
  assert.equal(nextZoomFactor(2, 'reset'), 1)
  let zoom = 1
  for (let index = 0; index < 30; index++) zoom = nextZoomFactor(zoom, 'in')
  assert.equal(zoom, 5)
})

test('a factor between steps snaps to the next step in the pressed direction', () => {
  assert.equal(nextZoomFactor(1.05, 'in'), 1.1)
  assert.equal(nextZoomFactor(1.05, 'out'), 1)
  assert.equal(nextZoomFactor(1.2, 'in'), 1.25)
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(nextZoomFactor(bad, 'in'), 1)
})
