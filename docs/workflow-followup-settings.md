# Project follow-up defaults and merge completion

In an unenrolled task's GitHub follow-ups form, enter its PR and desired reviewer/check settings. **Save these settings
for future tasks** stores a project template after verifying the repository and numeric reviewer identities. It does
not enroll any task or start a worker. Only task records created after the template's activation time offer **Use
project defaults for this task**. The person still supplies that task's PR and explicitly enables its enrollment.
Edits establish a new activation boundary. Removing a default does not change existing task grants.

The optional **Mark this task complete when this PR is verified merged** condition is off initially. An enabled
enrollment with that condition may complete its original nonterminal task only after a current GitHub PR response
explicitly reports merged, with the original scope/session/permissions still valid. A closed, unmerged PR never
completes it. Pausing, cancellation, scope changes or revoked permissions prevent completion. A resume baseline retains
an opted-in merged condition until authorization returns. Continuation budgets still prohibit further worker starts;
they do not suppress the bounded merge-condition read.

Completion records the verified repository, PR number, head/base revisions and observation time in local task history.
It cancels queued follow-ups and requests the existing safe interrupt for an active automatic turn. Uncertain delivery
evidence remains for reconciliation. Neither a default nor this condition merges a PR, posts a GitHub message, changes
tool permissions or treats CI success as task completion. The condition is configured alongside a reviewer/failed-check
follow-up source, rather than acting as a standalone merge watcher.

These controls require GitHub CLI access. Local tasks and manual terminals remain usable when that access is unavailable.
Validation covers durable templates without enrollment, stale-save/removal races, explicit acceptance in real Electron,
opted-in/out merges, closed-without-merge, pause/revocation during reads, resume and exhausted continuation budgets.
