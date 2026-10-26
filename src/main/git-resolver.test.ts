import assert from 'node:assert/strict'
import test from 'node:test'
import { GitResolverClaims } from './git-resolver.js'
import type { SessionState } from './git-resolver.js'

function clock(): { now: () => number; advance(ms: number): void } {
  let at = 1_000_000
  return { now: () => at, advance: (ms) => { at += ms } }
}

test('a sent task claims the repository from the moment it is sent until its turn ends', () => {
  const time = clock()
  const claims = new GitResolverClaims(time.now)
  let state: SessionState = 'idle'
  claims.claim('D:\\one', 'tab-1', 'Fix login', true, 'idle')
  assert.deepEqual(claims.forFolder('d:/one/', () => state), { tabId: 'tab-1', title: 'Fix login', working: true }, 'before Copilot reports the turn, and whatever the spelling')
  state = 'busy'
  assert.equal(claims.forFolder('D:\\one', () => state)?.working, true)
  state = 'idle'
  assert.equal(claims.forFolder('D:\\one', () => state), null, 'finished')
  assert.equal(claims.forFolder('D:\\other', () => state), null)
})

test('a turn that starts and ends while no panel asks is still seen through observe', () => {
  const claims = new GitResolverClaims(clock().now)
  let state: SessionState = 'idle'
  claims.claim('D:\\one', 'tab-1', 'Fix login', true, 'idle')
  state = 'busy'
  claims.observe(() => state)
  state = 'idle'
  claims.observe(() => state)
  assert.equal(claims.forFolder('D:\\one', () => state), null)
})

test('a task pasted into a busy session does not count that turn; it claims the repository only while its own turn runs', () => {
  const claims = new GitResolverClaims(clock().now)
  let state: SessionState = 'busy'
  claims.claim('D:\\one', 'tab-1', 'Fix login', false, 'busy')
  assert.equal(claims.forFolder('D:\\one', () => state)?.working, false, 'the turn already running is someone else\'s')
  state = 'idle'
  assert.deepEqual(claims.forFolder('D:\\one', () => state), { tabId: 'tab-1', title: 'Fix login', working: false }, 'waiting for Enter')
  state = 'busy'
  assert.equal(claims.forFolder('D:\\one', () => state)?.working, true)
  state = 'idle'
  assert.equal(claims.forFolder('D:\\one', () => state), null)
})

test('a claim lapses when its session is gone, when a sent task never shows up, and when a pasted one is never sent', () => {
  const time = clock()
  const claims = new GitResolverClaims(time.now)
  claims.claim('D:\\one', 'tab-1', 'A', true, 'idle')
  assert.equal(claims.forFolder('D:\\one', () => 'gone'), null)
  claims.claim('D:\\one', 'tab-1', 'A', true, 'idle')
  time.advance(61_000)
  assert.equal(claims.forFolder('D:\\one', () => 'idle'), null, 'sent, but no turn within a minute')
  claims.claim('D:\\one', 'tab-1', 'A', false, 'idle')
  time.advance(29 * 60_000)
  assert.notEqual(claims.forFolder('D:\\one', () => 'idle'), null)
  time.advance(2 * 60_000)
  assert.equal(claims.forFolder('D:\\one', () => 'idle'), null, 'pasted and left unsent')
})
