# Task adoption and history controls

Tasks offers every known open conversation in its Session selector. **Track this conversation** creates an Unknown
record without typing into the CLI, launching work, granting tools, or inventing an original request. This works for
older/unsupported conversations as manual tracking. When the installed CLI supports reports but the current process
does not, **Resume with task support** uses the existing session restart action; it does not change permissions.

**End current task and track another** requires an idle, empty prompt without a pending switch, meeting delivery,
automatic worker or unresolved handoff. It atomically ends the old record and creates a new assignment in Unknown,
then disables the old follow-up enrollment. The first verified submitted request populates the new original-request
copy. Unsubmitted text never starts a task, and an old worker's report cannot update the new assignment.

The person can set a recorded outcome independently of process activity, complete a task, or end tracking. These
controls report a person's choice; they do not assert an observed test result or start another CLI turn. Completed
or ended history can be deleted only after active automatic work and unresolved handoffs are reconciled. Deletion
removes the local task row; it preserves sessions, files, worktrees, delivery evidence and source ownership records.
Automatic terminal-history retention has the same filesystem boundary.

Validation uses SQLite rollback, assignment rejection and retention fixtures, production input gates with an inert PTY,
and renderer cases for unsupported conversations and history-only deletion. No live model was called.
