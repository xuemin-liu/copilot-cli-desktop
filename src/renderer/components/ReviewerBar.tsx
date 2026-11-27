import { useState } from 'react'
import type { JSX } from 'react'
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

/** The same seats for a review meeting, which has no pull request: a seat is in the meeting or it is not. */
const MEETING_VERDICT_LABEL: Record<TempReviewerSeatVerdict, string> = {
  ...VERDICT_LABEL,
  starting: 'joining…',
  reviewing: 'in the meeting',
  incomplete: 'left (session ended)',
}

const MEETING_OUTCOME_LABEL: Record<NonNullable<TempReviewerGroupView['outcome']>, string> = {
  ...OUTCOME_LABEL,
  closed: 'Meeting closed',
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
    payload?: string,
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
        const meeting = group.meetingId !== undefined
        const verdictLabel = meeting ? MEETING_VERDICT_LABEL : VERDICT_LABEL
        const stageSummary = ended
          ? (group.outcome ? (meeting ? MEETING_OUTCOME_LABEL : OUTCOME_LABEL)[group.outcome] : 'Ended')
          : group.stage === 'starting'
            ? (meeting ? 'Starting reviewers; round 1 waits for them…' : 'Starting reviewers…')
            : (meeting ? 'Reviewers in the meeting' : 'Reviewing on PR')
        return (
          <section
            key={group.id}
            className={`meeting-bar reviewer-bar reviewer-bar-${ended ? 'ended' : 'active'}`}
            aria-label={meeting ? `Hidden reviewers for ${group.prLabel}` : `Temporary PR reviewers for ${group.prLabel}`}
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
              {meeting
                ? <>{group.head ? <><code title="The commit each reviewer's checkout is pinned to">{group.head.slice(0, 7)}</code> · </> : 'no checkout · '}{stageSummary}</>
                : <><code>{group.head.slice(0, 7)}</code> · R{group.round} · {stageSummary}</>}
            </span>
            <ul className="reviewer-bar-seats" aria-label={`Reviewer seats for ${group.prLabel}`}>
              {group.seats.map((seat) => {
                const peeking = seat.tabId !== null && peekTabId === seat.tabId
                const canPeek = seat.tabId !== null
                const canRetry = !ended && seat.verdict !== 'starting'
                const canDismiss = !ended
                return (
                  <li
                    key={seat.id}
                    className={`reviewer-seat reviewer-seat-${seat.verdict}${seat.needsAttention ? ' reviewer-seat-attention' : ''}`}
                    title={seat.error ?? undefined}
                  >
                    <span className="reviewer-seat-name">{seat.label}</span>
                    <span className="reviewer-seat-verdict">
                      {seat.needsAttention && seat.verdict === 'reviewing' ? 'needs approval' : verdictLabel[seat.verdict]}
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
                        onClick={() => runAction(group.id, 'retry', seat.id)}
                      >
                        Retry
                      </button>
                    )}
                    {canDismiss && (
                      <button
                        type="button"
                        className="meeting-bar-button"
                        disabled={busy}
                        title={`Remove ${seat.label} from required reviewers for this run`}
                        onClick={() => runAction(group.id, 'dismiss', seat.id)}
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
                  aria-label={`Dismiss ${meeting ? 'hidden' : 'temporary'} reviewers for ${group.prLabel}`}
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
              <span key={`${seat.id}-err`} className="meeting-bar-note meeting-bar-quiet" role="status">
                {seat.label}: {seat.error}
              </span>
            ))}
          </section>
        )
      })}
    </div>
  )
}
