import assert from 'node:assert/strict'
import test from 'node:test'
import { formatDesktopDiagnostics, redactDiagnosticText } from './desktop-diagnostics.js'

test('redactDiagnosticText masks common secret shapes', () => {
  assert.equal(redactDiagnosticText('COPILOT_PROVIDER_API_KEY=sk-abc123'), 'COPILOT_PROVIDER_API_KEY=[REDACTED]')
  assert.equal(redactDiagnosticText('Authorization: Bearer abc.def.ghi'), 'Authorization: Bearer [REDACTED]')
  assert.equal(redactDiagnosticText('token used: gho_1234567890abcdefgh'), 'token used: [REDACTED]')
  assert.equal(
    redactDiagnosticText('https://example.com/x?access_token=abc123&other=1'),
    'https://example.com/x?access_token=[REDACTED]&other=1',
  )
})

test('redactDiagnosticText leaves ordinary text untouched', () => {
  assert.equal(redactDiagnosticText('Session started successfully.'), 'Session started successfully.')
})

test('formatDesktopDiagnostics includes resolution, tabs, and redacted logs', () => {
  const text = formatDesktopDiagnostics({
    desktopVersion: '0.1.0',
    resolution: { kind: 'direct', command: 'copilot', prefixArgs: [], resolvedPath: null, version: '0.9.1', error: null },
    activeWorkspace: 'C:\\work\\project',
    tabs: [{ title: 'Copilot', status: 'running', processId: 4242 }],
    recentLogs: ['GH_TOKEN=gho_1234567890abcdefgh should be redacted'],
    error: null,
  }, new Date('2026-08-24T00:00:00.000Z'))

  assert.match(text, /Desktop version: 0\.1\.0/)
  assert.match(text, /Copilot CLI resolution: direct \(copilot\) version 0\.9\.1/)
  assert.match(text, /Active workspace: C:\\work\\project/)
  assert.match(text, /Copilot: running \(pid 4242\)/)
  assert.doesNotMatch(text, /gho_1234567890abcdefgh/)
})

test('formatDesktopDiagnostics handles the empty/unresolved state', () => {
  const text = formatDesktopDiagnostics({
    desktopVersion: '0.1.0',
    resolution: null,
    activeWorkspace: null,
    tabs: [],
    recentLogs: [],
    error: null,
  })
  assert.match(text, /not attempted yet/)
  assert.match(text, /not selected/)
  assert.match(text, /\(none\)/)
})
