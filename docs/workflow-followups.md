# GitHub task follow-ups

In Tasks, expand **GitHub follow-ups**, name a github.com PR and reviewer logins, optionally select failed CI,
then enable it for that task. GitHub CLI must be installed and authenticated. This is a per-task grant, not a
project default. Enrollment records the current source baseline; it does not execute existing feedback.

Desktop polls at most five enrolled PRs every two minutes while running, backs off failed reads up to 30 minutes,
and reads paginated feedback and current-head checks with bounded responses. Reviewer matching uses verified numeric
GitHub identities, including explicitly named bot logins. A newer check run replaces an older failure of the same name.
Absent, pending, failed and completed checks are separate; completed does not claim all checks passed.

Before dispatch Desktop refreshes the PR and feedback version, verifies the original task/session/permission fingerprint,
checks positive live process ownership, and inspects the checkout using the Git panel's filesystem/config trust rules.
The origin, branch and HEAD must match the PR's head repository and the checkout must be clean. Dirty or moved checkouts
wait for the person. Unknown CLI versions, remote sessions and restricted side chats cannot receive these continuations.

The normal idle/empty/quiet prompt gate protects drafts and pickers; authorization is checked again before delayed Enter.
A native conversation switch invalidates pending input for the old recipient: its Enter, cancellation and held keys
cannot reach the replacement conversation. The original delivery remains uncertain for reconciliation.
Ordinary manual input keeps its existing behavior when ownership inventory is temporarily unavailable and no identity
changed. Automatic work still requires its verified binding and grant. Busy/draft/approval and unresolved-journal checks
run before dispatch refreshes; queued messages share a refreshed observation and busy attempts back off up to two minutes.
An unreadable journal blocks automatic meeting prompts and setup commands while manual terminal input remains available.
Meetings and workflow input cannot overlap, and uncertain journal entries block later automatic input to their session.
Feedback is untrusted context inside the original task scope. No model routes events or edits grants; source polling
does not post comments or merge PRs. Existing tool approval requirements still apply.

Limits are three accepted continuations per PR head, ten per enrollment, one unresolved delivery per session, two active
workers per project and ten minutes per active turn. A timeout requests Ctrl+C only on the matching automatic session;
an unconfirmed stop remains uncertain and keeps its active slot. Token/credit costs unknown to Desktop are not capped.
Pause disables the grant permanently, cancels queued deliveries and requests interruption of its automatic turn.
Re-enrollment requires the person and creates a new ID and source baseline. Completion/end tracking disables follow-ups;
ending tracking alone does not stop unrelated CLI work. Closed PRs disable their grant on the next observation.

The journal commits intent before typing. A live desktop turn ending in the same bound session answers that delivery;
this is activity evidence, not task success. After restart, submitting/submitted entries become uncertain. Use Handoffs
to inspect the session and choose Send again or Discard; there is no automatic resend of possibly executed input.
Keep Desktop and the linked CLI session running. Tray operation works; quitting stops polling.

Workflow-owned prompt copies are cleaned, bounded and redacted before journal persistence. Raw GitHub bodies are not
stored separately. Grants retain event IDs and hashes, not raw feedback. Up to 1,000 grants and 1,000 event hashes per
grant are retained; source limits stop intake. Retention deletes only permanently disabled grant scopes whose deliveries
are all answered/cancelled. Unresolved evidence is preserved. New enrollment IDs and fresh baselines prevent replay after
retirement. Store errors disable automatic work without disabling manual terminals.

Validation: deterministic GitHub/SQLite tests cover baselines, edits/deletions, stale heads and reruns, identity allowlists,
limits, pause and shutdown races, retirement, deduplication and uncertain recovery. A real local Git fixture exercises
origin/branch/head/dirty/trust checks. Production main lifecycle fixtures exercise draft preservation and revocation
between paste and Enter alongside existing meeting binding paths. No live PR is enrolled by these tests.

This supplies Phase 4 of the [plan](task-workflows-plan.md). The subsequent
[meeting migration](workflow-meeting-recovery.md) retains meeting files for round state and uses the same journal
for local prompt identities and submission recovery.
