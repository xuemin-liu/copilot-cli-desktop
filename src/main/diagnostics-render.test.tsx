import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DiagnosticsView } from '../renderer/components/DiagnosticsView.js'

test('compact CLI diagnostics preserve recovery actions beside existing terminals', () => {
  const markup = renderToStaticMarkup(
    <DiagnosticsView
      compact
      resolution={{
        kind: 'direct',
        command: 'copilot',
        prefixArgs: [],
        resolvedPath: null,
        version: null,
        error: 'copilot CLI was not found',
      }}
      onRetry={async () => {}}
      onInstall={async () => {}}
      onCopyDiagnostics={async () => {}}
    />,
  )

  assert.doesNotMatch(markup, /role="alert"/)
  assert.match(markup, /<h2>Copilot CLI is unavailable<\/h2>/)
  assert.match(markup, /<p role="status">Existing terminals remain available/)
  assert.match(markup, /Existing terminals remain available/)
  assert.match(markup, />Install Copilot CLI</)
  assert.match(markup, />Retry</)
  assert.match(markup, />Copy diagnostic summary</)
})
