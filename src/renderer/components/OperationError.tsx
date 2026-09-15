import type { JSX } from 'react'

export function OperationError({ message, onDismiss, className = '', tone = 'error' }: {
  message: string
  onDismiss?: () => void
  className?: string
  tone?: 'error' | 'info'
}): JSX.Element {
  return <div className={`session-operation-error${tone === 'info' ? ' session-operation-info' : ''} ${className}`} role={tone === 'error' ? 'alert' : 'status'}>
    <span>{message}</span>
    {onDismiss && <button type="button" onClick={onDismiss} aria-label="Dismiss message">×</button>}
  </div>
}
