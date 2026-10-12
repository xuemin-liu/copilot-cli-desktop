import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_DETAIL_CHARS, MAX_TIMESTAMP_AGE_MS, clampTimestamp, cleanFileDetail, formatActivityLabel, formatElapsed,
  sameActivityDetail, toolDetailFor, toolTitleFor,
} from './activity-label.js'

test('tool titles are allowlisted by tool name; MCP, unknown and non-string names read "Running tool"', () => {
  assert.equal(toolTitleFor('powershell'), 'Running command')
  assert.equal(toolTitleFor('bash'), 'Running command')
  assert.equal(toolTitleFor('view'), 'Viewing')
  assert.equal(toolTitleFor('apply_patch'), 'Editing')
  assert.equal(toolTitleFor('rg'), 'Searching')
  assert.equal(toolTitleFor('web_fetch'), 'Fetching')
  assert.equal(toolTitleFor('ask_user'), 'Asking you')
  for (const name of ['github-mcp-server-create_issue', 'rename_branch', 'constructor', '__proto__', 'toString', '', 42, null, undefined, { toString: () => 'view' }]) {
    assert.equal(toolTitleFor(name), 'Running tool', String(name))
  }
})

test('file details are the cleaned last path segment, bounded, and only for file tools', () => {
  assert.equal(cleanFileDetail('C:\\Users\\me\\project\\src\\auth\\withSession.ts'), 'withSession.ts')
  assert.equal(cleanFileDetail('/home/me/project/src/index.ts/'), 'index.ts')
  assert.equal(cleanFileDetail('src/\u202Esj.evil\u0000\u200B.txt'), 'sj.evil.txt')
  assert.equal(cleanFileDetail('   '), null)
  assert.equal(cleanFileDetail('\u200B\u200B'), null)
  assert.equal(cleanFileDetail(['a']), null)
  const long = cleanFileDetail(`${'a'.repeat(100)}.ts`)
  assert.equal(long?.length, MAX_DETAIL_CHARS)
  assert.ok(long?.endsWith('…'))
  assert.equal(toolDetailFor('view', { path: 'D:\\repo\\README.md' }), 'README.md')
  assert.equal(toolDetailFor('edit', { path: 'D:\\repo\\a.ts' }), 'a.ts')
  // Shell commands and their descriptions are never shown, whatever the arguments contain.
  assert.equal(toolDetailFor('powershell', { command: 'curl -H "Authorization: Bearer x"', description: 'leak', path: 'x' }), null)
  assert.equal(toolDetailFor('github-mcp', { path: 'README.md' }), null)
  assert.equal(toolDetailFor('view', 'not an object'), null)
  assert.equal(toolDetailFor('view', { path: 7 }), null)
})

test('record timestamps are parsed and clamped into the last day, falling back to now', () => {
  const now = Date.UTC(2026, 9, 12, 12, 0, 0)
  assert.equal(clampTimestamp(new Date(now - 5_000).toISOString(), now), now - 5_000)
  assert.equal(clampTimestamp(new Date(now + 60_000).toISOString(), now), now, 'future timestamps clamp to now')
  assert.equal(clampTimestamp('1999-01-01T00:00:00.000Z', now), now - MAX_TIMESTAMP_AGE_MS)
  for (const bad of [undefined, null, 'yesterday', 12345, '']) assert.equal(clampTimestamp(bad, now), now, String(bad))
})

test('elapsed time rounds down to whole seconds, minutes and hours', () => {
  const start = 1_000_000
  assert.equal(formatElapsed(start, start + 999), '0s')
  assert.equal(formatElapsed(start, start + 4_200), '4s')
  assert.equal(formatElapsed(start, start + 130_000), '2m 10s')
  assert.equal(formatElapsed(start, start + 3_600_000 + 61_000), '1h 1m')
  assert.equal(formatElapsed(start + 5_000, start), '0s', 'a since in the future never shows a negative time')
})

test('labels list at most two tools with details and count the rest', () => {
  assert.equal(formatActivityLabel({ kind: 'thinking', since: 1 }), 'Thinking')
  assert.equal(formatActivityLabel({ kind: 'tools', since: 1, tools: [] }), 'Thinking')
  assert.equal(formatActivityLabel({ kind: 'tools', since: 1, tools: [{ title: 'Running command', detail: null }] }), 'Running command')
  assert.equal(formatActivityLabel({
    kind: 'tools', since: 1,
    tools: [{ title: 'Running command', detail: null }, { title: 'Viewing', detail: 'a.ts' }, { title: 'Searching', detail: null }, { title: 'Viewing', detail: 'b.ts' }],
  }), 'Running command, Viewing a.ts +2')
})

test('detail equality compares kind, start and the tool list', () => {
  const tools = { kind: 'tools' as const, since: 1, tools: [{ title: 'Viewing', detail: 'a.ts' }] }
  assert.ok(sameActivityDetail(null, null))
  assert.ok(sameActivityDetail(tools, { ...tools, tools: [{ title: 'Viewing', detail: 'a.ts' }] }))
  assert.ok(sameActivityDetail({ kind: 'thinking', since: 1 }, { kind: 'thinking', since: 1 }))
  assert.ok(!sameActivityDetail(tools, null))
  assert.ok(!sameActivityDetail(tools, { kind: 'thinking', since: 1 }))
  assert.ok(!sameActivityDetail(tools, { ...tools, since: 2 }))
  assert.ok(!sameActivityDetail(tools, { ...tools, tools: [{ title: 'Viewing', detail: 'b.ts' }] }))
  assert.ok(!sameActivityDetail(tools, { ...tools, tools: [] }))
})
