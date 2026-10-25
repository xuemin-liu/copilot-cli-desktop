import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionHistoryEntry } from './types.js'
import { SessionHistoryDialog } from '../renderer/components/SessionHistoryDialog.js'
import { filterSessionHistory, formatLastUsed, historyTitle } from '../renderer/session-history.js'

const NOW = Date.UTC(2026, 9, 24, 12)
const entry = (overrides: Partial<SessionHistoryEntry>): SessionHistoryEntry => ({
  sessionId: '11111111-1111-4111-8111-111111111111', name: 'copilot-cli-desktop', userNamed: true, cwd: 'D:\\githutb\\copilot-cli-desktop',
  gitRoot: 'D:\\githutb\\copilot-cli-desktop', repository: 'me/copilot-cli-desktop', branch: 'main', createdAt: null, updatedAt: NOW - 5 * 60_000,
  firstPrompt: 'fix the login bug', lastPrompt: 'now add a test', openTabId: null, projectName: 'copilot-cli-desktop', ...overrides,
})

test('a session named after its folder is shown by its first prompt; a real name is kept', () => {
  assert.equal(historyTitle(entry({})), 'fix the login bug')
  assert.equal(historyTitle(entry({ name: 'Login refactor' })), 'Login refactor')
  assert.equal(historyTitle(entry({ name: null })), 'fix the login bug')
})

test('every searched word must match the name, prompts, branch or folder', () => {
  const entries = [entry({}), entry({ sessionId: '22222222-2222-4222-8222-222222222222', firstPrompt: 'explain the parser', lastPrompt: null, branch: 'feat/parser' })]
  assert.equal(filterSessionHistory(entries, '').length, 2)
  assert.deepEqual(filterSessionHistory(entries, 'PARSER').map((item) => item.branch), ['feat/parser'])
  assert.deepEqual(filterSessionHistory(entries, 'login test').map((item) => item.firstPrompt), ['fix the login bug'])
  assert.deepEqual(filterSessionHistory(entries, 'login parser'), [])
})

test('last use reads in minutes, hours, days, then a date', () => {
  assert.equal(formatLastUsed(NOW - 20_000, NOW), 'just now')
  assert.equal(formatLastUsed(NOW - 5 * 60_000, NOW), '5 min ago')
  assert.equal(formatLastUsed(NOW - 3 * 3_600_000, NOW), '3 h ago')
  assert.equal(formatLastUsed(NOW - 30 * 3_600_000, NOW), 'yesterday')
  assert.equal(formatLastUsed(NOW - 3 * 86_400_000, NOW), '3 days ago')
  assert.equal(formatLastUsed(NOW - 30 * 86_400_000, NOW), new Date(NOW - 30 * 86_400_000).toLocaleDateString())
})

test('the history dialog shows each session by its prompts, with its project, branch and state', () => {
  const html = renderToStaticMarkup(<SessionHistoryDialog now={NOW} pendingSessionId={null} loadError={null} openError={null} onOpen={() => {}} onClose={() => {}}
    entries={[entry({}), entry({ sessionId: '22222222-2222-4222-8222-222222222222', name: 'Parser work', firstPrompt: 'explain the parser', lastPrompt: null,
      openTabId: 'tab-3', branch: null }), entry({ sessionId: '33333333-3333-4333-8333-333333333333', projectName: null, cwd: 'D:\\elsewhere\\tool' })]} />)
  assert.match(html, /session-history-title">fix the login bug</)
  assert.match(html, /Latest: now add a test/)
  assert.match(html, /copilot-cli-desktop · ⎇ main · 5 min ago/)
  assert.match(html, /session-history-title">Parser work<.*explain the parser.*>Open</s)
  assert.match(html, /tool · ⎇ main · 5 min ago<span class="session-history-badge">Adds its project/)
  assert.match(renderToStaticMarkup(<SessionHistoryDialog entries={null} pendingSessionId={null} loadError={null} openError={null} onOpen={() => {}} onClose={() => {}} />),
    /Reading stored sessions/)
  assert.match(renderToStaticMarkup(<SessionHistoryDialog entries={[]} pendingSessionId={null} loadError={null} openError={null} onOpen={() => {}} onClose={() => {}} />),
    /No stored sessions with a prompt yet/)
})
