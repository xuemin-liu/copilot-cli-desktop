import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionLifecycleStatus } from './types.js'
import { SessionStoppedNotice, sessionStopped, stoppedNoticeContent } from '../renderer/components/SessionStoppedNotice.js'

function render(status: SessionLifecycleStatus, options: { remote?: boolean; hasText?: boolean } = {}): string {
  return renderToStaticMarkup(<SessionStoppedNotice tab={{ status, remote: options.remote ?? false }}
    hasText={options.hasText ?? false} focused onRestart={() => undefined} onShowLog={() => undefined} />)
}

test('a session without a process says why its terminal is empty and how to start it', () => {
  const dormant = render('dormant')
  assert.match(dormant, /This session is not running/)
  assert.match(dormant, />Resume session</)
  assert.doesNotMatch(dormant, /Show log/)

  const crashed = render('crashed')
  assert.match(crashed, /This session stopped unexpectedly/)
  assert.match(crashed, />Restart session</)
  assert.match(crashed, />Show log</)

  const completed = render('completed')
  assert.match(completed, /This session has ended/)
  assert.match(completed, />Restart session</)
  assert.doesNotMatch(completed, /Show log/)

  // A restart starts a new conversation when the CLI no longer stores the old one, so nothing is promised.
  for (const markup of [dormant, crashed, completed]) assert.doesNotMatch(markup, /saved|conversation|continue/i)
})

test('a session that runs or needs approval has no notice, local or remote', () => {
  for (const status of ['running', 'approval-needed', 'stopping'] as const) {
    for (const remote of [false, true]) {
      assert.equal(render(status, { remote }), '')
      assert.equal(stoppedNoticeContent({ status, remote }), null)
      assert.equal(sessionStopped({ status, remote }), false)
    }
  }
})

test('a starting session says so over an empty terminal only, and offers nothing to press', () => {
  for (const remote of [false, true]) {
    const starting = render('starting', { remote })
    assert.match(starting, /Starting…/)
    assert.doesNotMatch(starting, /<button/)
    assert.doesNotMatch(starting, /connection/)
    assert.equal(render('starting', { remote, hasText: true }), '')
    assert.equal(sessionStopped({ status: 'starting', remote }), false)
  }
})

test('a stopped remote session speaks of its connection and has no button', () => {
  for (const status of ['crashed', 'completed', 'dormant'] as const) {
    const markup = render(status, { remote: true })
    assert.match(markup, /The connection to this remote session ended/)
    assert.match(markup, /Close this tab and connect again/)
    assert.doesNotMatch(markup, /<button/)
  }
})

test('the notice is a card over an empty terminal and a bar under one that still has text', () => {
  assert.match(render('dormant'), /session-stopped-overlay/)
  assert.doesNotMatch(render('dormant'), /session-stopped-bar/)
  const bar = render('crashed', { hasText: true })
  assert.match(bar, /session-stopped-bar/)
  assert.doesNotMatch(bar, /session-stopped-overlay/)
  assert.match(bar, />Restart session</)
})
