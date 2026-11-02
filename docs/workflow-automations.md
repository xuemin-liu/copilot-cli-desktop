# Preview-first investigation rules

Open **Automation** in the sidebar. Choose a local project, `owner/repository`, one of two built-in templates,
and allowed actor identities. New and edited rules always start in Preview. There is no executable rule language.

- **New issue assigned to my GitHub account** accepts assignment events from explicitly named GitHub users/bots.
  The issue must currently be open and assigned to the authenticated account. Editing an issue body alone is not a new assignment.
- **Failed default-branch CI check** accepts current failed/timed-out check runs from explicitly named GitHub app slugs.
  App IDs and user IDs are distinct. The newest run for an app/check name supersedes older runs. Legacy commit statuses
  are supported by task follow-ups, but are not a rule-created investigation source in this release.

Preview stores a bounded, cleaned/redacted reason and source version. It starts no model or session, creates no worktree
or PR, and posts no external message. **Start selected preview** revalidates that evidence before launching an investigation.
**Enable Automatic for new events** records a fresh baseline and new rule revision. It never executes existing previews.
Editing, changing mode or resuming a project/global pause invalidates older pending preview authorization.

Automatic investigations use a new dedicated worktree and a fixed restricted read/search tool allowlist, with the
project's configured model/provider. They inspect the source and propose next steps for the person. They cannot edit
files, run shell commands or invoke the task-report helper. Their outcome is therefore Unknown after an observed turn
ends; review the session and explicitly complete/end the task. An idle worker is never proof of successful work.
Follow-ups to an existing task retain that task's original permissions instead.

Before any launch, Desktop checks the configured project/launch fingerprint, current event version and allowed actor,
and verifies a clean local checkout of the repository's current default branch/head through the Git panel's trust checks.
It persists a source ownership reservation before creating a session or worktree, then commits a journal delivery before
typing into the positively verified recipient's idle, empty, quiet prompt. The dedicated checkout's head is verified again.
Source text is untrusted context, not authority to change rules or scope. Restricted launches require tested CLI 1.0.105
and its explicit tool allowlist; missing capabilities fail closed.

Rules allow at most three starts per day and ten total each; editing a rule preserves its consumed budget. At most two
automatic workers per project share slots with task follow-ups. Each active turn has a ten-minute interrupt deadline.
The app does not claim a token/credit cost cap. Pausing requests interruption only for matching automatic work and
retains uncertain delivery evidence until reconciled. Manual sessions and drafts keep their normal behavior.

**Pause project** and **Pause all automatic work** persist across restart and apply to both rule-created tasks and
task follow-ups. A global pause takes precedence. Resume refreshes source baselines before allowing new work; a newer
pause request supersedes an in-flight resume. Off rules collect nothing. Desktop must remain running (tray is supported).

A durable source owner prevents overlapping rules or revisions from launching the same issue/check twice, including
after restart. A possibly interrupted launch becomes Uncertain and never automatically retries. Inspect Tasks, sessions
and worktrees to recover that work manually. No cleanup operation deletes those resources. Source owner tombstones
outlive preview retention. Maximums: five configured rules, 1,000 source versions per rule, 1,000 previews per project,
30 days of ordinary preview history, 1,000 ownership records. Unresolved launch evidence is preserved, and intake stops
at a limit when it cannot be pruned safely. GitHub reads are paginated and bounded; polling is every two minutes with
backoff up to thirty minutes after failures. Store/source errors appear in the panel and disable affected automatic work.

Validation includes real SQLite state and deterministic GitHub fixtures for preview side effects, promotion, Off,
overlap/restart, actor allowlists, pause races, limits, redaction and uncertain launches. The production main lifecycle
fixture uses real disposable Git checkouts and a simulated PTY to verify a restricted worktree/task/journal submission
and that its desktop turn cannot impersonate a person's meeting request. It never uses a paid model or enrolls a live PR.

This implements Phase 5 of the [workflow plan](task-workflows-plan.md). The initial templates produce investigations;
they do not automatically implement or merge the proposed fixes.
