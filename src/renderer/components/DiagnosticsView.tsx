import { useState } from 'react'
import type { JSX } from 'react'
import type { CopilotResolution } from '../../main/types.js'

export interface DiagnosticsViewProps {
  resolution: CopilotResolution | null
  onRetry: () => Promise<void>
  onInstall: () => Promise<void>
  onCopyDiagnostics: () => Promise<void>
  compact?: boolean
}

export function DiagnosticsView({ resolution, onRetry, onInstall, onCopyDiagnostics, compact = false }: DiagnosticsViewProps): JSX.Element {
  const [retrying, setRetrying] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleRetry = (): void => {
    setRetrying(true)
    void onRetry().finally(() => setRetrying(false))
  }

  const handleInstall = (): void => {
    setInstalling(true)
    setError(null)
    void onInstall()
      .catch((installError: unknown) => setError(installError instanceof Error ? installError.message : String(installError)))
      .finally(() => setInstalling(false))
  }

  const handleCopy = (): void => {
    void onCopyDiagnostics().then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2_000)
    })
  }

  return (
    <div className={`diagnostics-view${compact ? ' diagnostics-view-compact' : ''}`} role={compact ? 'alert' : undefined}>
      <h1>{compact ? 'Copilot CLI is unavailable' : 'Copilot CLI was not found'}</h1>
      {compact ? (
        <p>Existing terminals remain available, but new sessions need the Copilot CLI. Install it or retry detection.</p>
      ) : (
        <p>
          This desktop app could not locate the <code>copilot</code> binary. Install the official npm package below, or get it from{' '}
          <a href="https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli" target="_blank" rel="noreferrer">
            GitHub's installation guide
          </a>
          , then retry.
        </p>
      )}
      <div className="diagnostics-actions">
        <button type="button" className="primary-button" onClick={handleInstall} disabled={installing || retrying}>
          {installing ? 'Installing…' : 'Install Copilot CLI'}
        </button>
        <button type="button" onClick={handleRetry} disabled={retrying}>
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
        <button type="button" onClick={handleCopy}>
          {copied ? 'Copied!' : 'Copy diagnostic summary'}
        </button>
      </div>
      {error && <p className="settings-warning">{error}</p>}
      {resolution?.error && (
        <div className="diagnostics-detail">
          <h2>Details</h2>
          <pre>{resolution.error}</pre>
        </div>
      )}
    </div>
  )
}
