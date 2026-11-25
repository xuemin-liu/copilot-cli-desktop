import { useState } from 'react'
import type { JSX } from 'react'
import { sessionCliLabel, type ReviewerCli } from '../../main/session-cli.js'
import type { TempReviewerConfirmTarget, TempReviewerGroupView, TempReviewerSeatVerdict } from '../../main/types.js'

export interface ReviewerBarProps {
  groups: readonly TempReviewerGroupView[]
  activeTabId: string | null
  peekTabId: string | null
  onPeek(tabId: string | null): void
  onError(message: string): void
}

const VERDICT_LABEL: Record<TempReviewerSeatVerdict, string> = {
  starting: 'starting…',
  reviewing: 'reviewing…',
  'changes-requested': 'changes requested',
  approved: 'approved',
  'held-approval': 'approved (missing checks)',
  settling: 'posting…',
  uncertain: 'post uncertain',
  failed: 'failed',
  stopped: 'stopped',
}

const OUTCOME_LABEL: Record<NonNullable<TempReviewerGroupView['outcome']>, string> = {
  confirmed: 'Approval confirmed',
  merged: 'PR merged',
  closed: 'PR closed',
  stopped: 'Stopped',
}

export function reviewerConfirmButtonLabel(target: TempReviewerConfirmTarget): string {
  if (!target.approveAnyway) return 'Confirm approval'
  const details = target.missingChecks
    .filter((entry) => entry.missing.length > 0)
    .map((entry) => `${sessionCliLabel(entry.cli)}: ${entry.missing.join(', ')}`)
    .join('; ')
  return details ? `Approve anyway (missing: ${details})` : 'Approve anyway'
}

export function ReviewerBar({ groups, activeTabId, peekTabId, onPeek, onError }: ReviewerBarProps): JSX.Element | null {
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null)
  if (!activeTabId) return null
  const shown = groups.filter((group) => (
    group.hostTabId === activeTabId || group.seats.some((seat) => seat.tabId === activeTabId)
  ))
  if (shown.length === 0) return null

  const runAction = (
    groupId: string,
    action: 'stop' | 'confirm' | 'retry' | 'dismiss' | 'dismiss-ended',
    payload?: ReviewerCli | TempReviewerConfirmTarget,
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
          : group.confirmTarget
            ? 'Ready to confirm'
            : group.stage === 'starting'
              ? 'Starting reviewers…'
              : 'Reviewing'
        return (
          <section
            key={group.id}
            className={`meeting-bar reviewer-bar reviewer-bar-${ended ? 'ended' : group.confirmTarget ? 'ready' : 'active'}`}
            aria-label={`Temporary PR reviewers for #${group.prNumber}`}
          >
            <button
              type="button"
              className="meeting-bar-button reviewer-bar-pr"
              title={`Open ${group.prUrl}`}
              onClick={() => {
                void window.copilotDesktop.openExternalUrl(group.prUrl)
                  .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
              }}
            >
              PR #{group.prNumber}
            </button>
            <span className="reviewer-bar-meta">
              <code>{group.head.slice(0, 7)}</code> · {stageSummary}
            </span>
            <ul className="reviewer-bar-seats" aria-label={`Reviewer seats for PR #${group.prNumber}`}>
              {group.seats.map((seat) => {
                const peeking = seat.tabId !== null && peekTabId === seat.tabId
                const canPeek = seat.tabId !== null && activeTabId === group.hostTabId
                const canRecover = !ended && (seat.verdict === 'failed' || seat.verdict === 'stopped')
                return (
                  <li
                    key={seat.cli}
                    className={`reviewer-seat reviewer-seat-${seat.verdict}${seat.needsAttention ? ' reviewer-seat-attention' : ''}`}
                    title={seat.error ?? (seat.missingChecks.length > 0 ? `Missing checks: ${seat.missingChecks.join(', ')}` : undefined)}
                  >
                    <span className="reviewer-seat-name">{sessionCliLabel(seat.cli)}</span>
                    <span className="reviewer-seat-verdict">{VERDICT_LABEL[seat.verdict]}</span>
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
                    {canRecover && (
                      <>
                        <button
                          type="button"
                          className="meeting-bar-button"
                          disabled={busy}
                          onClick={() => runAction(group.id, 'retry', seat.cli)}
                        >
                          Retry
                        </button>
                        <button
                          type="button"
                          className="meeting-bar-button"
                          disabled={busy}
                          title={`Remove ${sessionCliLabel(seat.cli)} from required reviewers for this run`}
                          onClick={() => runAction(group.id, 'dismiss', seat.cli)}
                        >
                          Dismiss
                        </button>
                      </>
                    )}
                  </li>
                )
              })}
            </ul>
            <div className="reviewer-bar-actions">
              {!ended && group.confirmTarget && (
                <button
                  type="button"
                  className="primary-button reviewer-bar-confirm"
                  disabled={busy}
                  onClick={() => runAction(group.id, 'confirm', group.confirmTarget!)}
                >
                  {reviewerConfirmButtonLabel(group.confirmTarget)}
                </button>
              )}
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
                  aria-label={`Dismiss temporary reviewers for PR #${group.prNumber}`}
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
