import { useState } from 'react'
import type { JSX } from 'react'
import { sessionCliLabel, type ReviewerCli } from '../../main/session-cli.js'
import type { TempReviewerGroupView, TempReviewerSeatVerdict } from '../../main/types.js'

export interface ReviewerBarProps {
  groups: readonly TempReviewerGroupView[]
  activeTabId: string | null
  activeProfileId?: string | null
  peekTabId: string | null
  onPeek(tabId: string | null): void
  onError(message: string): void
}

const VERDICT_LABEL: Record<TempReviewerSeatVerdict, string> = {
  starting: 'starting…',
  reviewing: 'reviewing on PR…',
  approved: 'approved',
  findings: 'posted findings',
  incomplete: 'incomplete (no PR post)',
  'timed-out': 'timed out',
  failed: 'failed',
  stopped: 'stopped',
}

const OUTCOME_LABEL: Record<NonNullable<TempReviewerGroupView['outcome']>, string> = {
  approved: 'Approved on PR',
  merged: 'PR merged',
  closed: 'PR closed',
  stopped: 'Stopped',
}

export function ReviewerBar({ groups, activeTabId, activeProfileId = null, peekTabId, onPeek, onError }: ReviewerBarProps): JSX.Element | null {
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null)
  if (!activeTabId && !activeProfileId) return null
  const shown = groups.filter((group) => (
    (activeTabId !== null && (group.hostTabId === activeTabId || group.seats.some((seat) => seat.tabId === activeTabId)))
    || (group.hostTabId === null && activeProfileId !== null && group.profileId === activeProfileId)
  ))
  if (shown.length === 0) return null

  const runAction = (
    groupId: string,
    action: 'stop' | 'retry' | 'dismiss' | 'dismiss-ended',
    payload?: ReviewerCli,
  ): void => {
    setBusyGroupId(groupId)
    void window.copilotDesktop.tempReviewerAction(groupId, action, payload)
      .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusyGroupId((current) => (current === groupId ? null : current)))
  }

  return (
    <div className="meeting-bars reviewer-bars">
      {shown.map((group) => {
        const ended = group.stage === 'ended'
        const busy = busyGroupId === group.id
        const stageSummary = ended
          ? (group.outcome ? OUTCOME_LABEL[group.outcome] : 'Ended')
          : group.stage === 'starting'
            ? 'Starting reviewers…'
            : 'Reviewing on PR'
        return (
          <section
            key={group.id}
            className={`meeting-bar reviewer-bar reviewer-bar-${ended ? 'ended' : 'active'}`}
            aria-label={`Temporary PR reviewers for ${group.prLabel}`}
          >
            {group.prUrl ? (
              <button
                type="button"
                className="meeting-bar-button reviewer-bar-pr"
                title={`Open ${group.prUrl}`}
                onClick={() => {
                  void window.copilotDesktop.openExternalUrl(group.prUrl!)
                    .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
                }}
              >
                {group.prLabel}
              </button>
            ) : (
              <span className="reviewer-bar-pr" title={group.repository}>
                {group.prLabel}
              </span>
            )}
            <span className="reviewer-bar-meta">
              <code>{group.head.slice(0, 7)}</code> · R{group.round} · {stageSummary}
            </span>
            <ul className="reviewer-bar-seats" aria-label={`Reviewer seats for ${group.prLabel}`}>
              {group.seats.map((seat) => {
                const peeking = seat.tabId !== null && peekTabId === seat.tabId
                const canPeek = seat.tabId !== null
                const canRetry = !ended && seat.verdict !== 'starting'
                const canDismiss = !ended
                return (
                  <li
                    key={seat.cli}
                    className={`reviewer-seat reviewer-seat-${seat.verdict}${seat.needsAttention ? ' reviewer-seat-attention' : ''}`}
                    title={seat.error ?? undefined}
                  >
                    <span className="reviewer-seat-name">{sessionCliLabel(seat.cli)}</span>
                    <span className="reviewer-seat-verdict">
                      {seat.needsAttention && seat.verdict === 'reviewing' ? 'needs approval' : VERDICT_LABEL[seat.verdict]}
                    </span>
                    {canPeek && (
                      <button
                        type="button"
                        className="meeting-bar-button"
                        aria-pressed={peeking}
                        onClick={() => onPeek(peeking ? null : seat.tabId)}
                      >
                        {peeking ? 'Hide' : 'Peek'}
                      </button>
                    )}
                    {canRetry && (
                      <button
                        type="button"
                        className="meeting-bar-button"
                        disabled={busy}
                        onClick={() => runAction(group.id, 'retry', seat.cli)}
                      >
                        Retry
                      </button>
                    )}
                    {canDismiss && (
                      <button
                        type="button"
                        className="meeting-bar-button"
                        disabled={busy}
                        title={`Remove ${sessionCliLabel(seat.cli)} from required reviewers for this run`}
                        onClick={() => runAction(group.id, 'dismiss', seat.cli)}
                      >
                        Dismiss
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
            <div className="reviewer-bar-actions">
              {!ended ? (
                <button
                  type="button"
                  className="meeting-bar-button meeting-bar-stop"
                  disabled={busy}
                  onClick={() => runAction(group.id, 'stop')}
                >
                  Stop reviewers
                </button>
              ) : (
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Dismiss temporary reviewers for ${group.prLabel}`}
                  onClick={() => runAction(group.id, 'dismiss-ended')}
                >
                  ×
                </button>
              )}
            </div>
            {group.notice && (
              <span className="meeting-bar-note reviewer-bar-notice" role="status">{group.notice}</span>
            )}
            {group.seats.filter((s) => s.error && !ended).map((seat) => (
              <span key={`${seat.cli}-err`} className="meeting-bar-note meeting-bar-quiet" role="status">
                {sessionCliLabel(seat.cli)}: {seat.error}
              </span>
            ))}
          </section>
        )
      })}
    </div>
  )
}
