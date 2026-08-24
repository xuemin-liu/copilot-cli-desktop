import { useState } from 'react'
import type { JSX } from 'react'
import type { CopilotResolution } from '../../main/types.js'

export interface DiagnosticsViewProps {
  resolution: CopilotResolution | null
  onRetry: () => Promise<void>
  onCopyDiagnostics: () => Promise<void>
}

export function DiagnosticsView({ resolution, onRetry, onCopyDiagnostics }: DiagnosticsViewProps): JSX.Element {
  const [retrying, setRetrying] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleRetry = (): void => {
    setRetrying(true)
    void onRetry().finally(() => setRetrying(false))
  }

  const handleCopy = (): void => {
    void onCopyDiagnostics().then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2_000)
    })
  }

  return (
    <div className="diagnostics-view">
      <h1>Copilot CLI was not found</h1>
      <p>
        This desktop app could not locate the <code>copilot</code> binary. Install it from{' '}
        <a href="https://github.com/github/copilot-cli" target="_blank" rel="noreferrer">
          github.com/github/copilot-cli
        </a>
        , or install the GitHub CLI and run <code>gh extension install github/gh-copilot</code>, then retry.
      </p>
      <div className="diagnostics-actions">
        <button type="button" onClick={handleRetry} disabled={retrying}>
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
        <button type="button" onClick={handleCopy}>
          {copied ? 'Copied!' : 'Copy diagnostic summary'}
        </button>
      </div>
      {resolution?.error && (
        <div className="diagnostics-detail">
          <h2>Details</h2>
          <pre>{resolution.error}</pre>
        </div>
      )}
    </div>
  )
}
