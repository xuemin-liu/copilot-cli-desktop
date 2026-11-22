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

## Starting a PR loop: just ask

In a Copilot tab, ask in your own words, as you would start a meeting:

- **"review PR 287"** (or a PR URL): Desktop starts a sandboxed review loop for it in a new tab. A PR that does not
  exist yet (you are creating it in another tab) is checked for every thirty seconds for an hour and reviewed when it
  opens.
- **"review my PR"**: your one open PR here is reviewed; with several, Desktop lists them and you say which; with none,
  it waits for your next new PR as below.
- **"review new PRs in this repo"**: each new pull request of yours in this project gets a review loop as it opens, like
  `/review-pr`'s wait for the next PR. A review that started turns this on as well, for the project it used;
  **"stop reviewing new PRs"** turns it off, also while a check is under way. Desktop checks with `gh` every thirty
  seconds, which uses no model and no tokens; a model runs only when a review starts. One review starts at a time, with
  no daily cap. Only PRs opened after it was turned on count; a fork, someone else's PR or one already in review is
  skipped. If the project's origin changes, nothing starts until you ask again.
- **"watch PR 286 and fix the review feedback"** (or "fix PR 286", "address the comments on PR 286", or without a
  number, **"fix my PR"** / "watch this PR and fix the review feedback" for the PR of the branch this conversation is on): this
  conversation becomes the PR's fix loop, with your own account as the reviewer whose feedback counts, and the
  feedback already on the PR first.

The session runs the helper's `pr-start`, and Desktop decides only from the message you typed, as it does for "join
meeting K7QF": a PR comment, a file or the code under review cannot start a loop. A PR number means the PR in this
project's GitHub repository. The Tasks entries below do the same with more choices.

## Fix loop (PR author)

In a task's **GitHub follow-ups**, choose **Fix review feedback (fix loop)** to run the desktop's version of `/fix-pr`
on that task's own PR ([plan](pr-loops-plan.md), Phase 1). It is a separate consent: the session keeps its own tool
permissions, which govern its edits, commits and pushes, and, unlike a follow-up, it may post replies on this one PR.

- New feedback from the named reviewers wakes the session, whatever commit it was posted on. Comments that start with
  the marker `🤖 ` are the author's own replies and never wake it, so author and reviewer may share a GitHub account.
  Optionally, the reviewers' feedback already on the PR is taken once at the start.
- Replies go through the session helper's `pr-reply -To <comment id>|conversation -File <reply.md>`, never through
  `gh`. Desktop checks that the loop belongs to that session, that GitHub is signed in to the account the loop was
  enrolled with, that the PR is open and the comment is on it, and that the reply starts with the marker and is not an
  approval. Each reply has a receipt: its intent is saved before the write, and a hidden tag in the body lets Desktop
  find out later whether a reply whose write was not confirmed landed. If it cannot tell, the task shows the reply for
  you to check, and nothing is posted again by itself.
- A push does not drop feedback that is queued but not typed yet: the batch moves to the new head with its budget.
- An approval of the current head (a formal approval from an allowed reviewer who is not the PR author, or a comment
  starting `Approved at <full head sha>`) shows **Confirm approval**. GitHub does not record which base an outside
  review saw, so the loop ends only when you confirm, the PR still points at that head, and nothing of the loop is
  queued, in flight or unsettled. A changes-requested review after it, a dismissal or a push clears it.
- Both PR loops read their PR every twenty seconds, so a review comment reaches the author, and a push reaches the
  reviewer, within about twenty seconds. Reading uses no model; a model runs only when there is something to act on.
- Each loop starts with three continuations per PR head and thirty in total. **Allow ten more** increases the total allowance and, when the current head has reached its own allowance, increases that allowance too. The ceiling is one hundred. A spent
  loop still notices approvals and merges. Each turn may run for thirty minutes. CI is read only when you ask for it.

## Review loop (PR reviewer)

**Tasks → Review a PR** runs the desktop's version of `/review-pr` ([plan](pr-loops-plan.md), Phase 2). It asks for its
own consent, because the review session runs the PR's code.

- Desktop fetches the PR's head into your project under a ref of the review's own (`refs/desktop-review/<id>`) and
  adds a detached `git worktree` of it, hooks off, in a reviewer folder beside (never inside) its data folder, as
  `/review-pr` does. Nothing is copied, so a huge repository costs no more than one checkout; your own worktree and
  branch are never touched. Nothing of the PR is installed, built or
  run outside the sandbox. Only your own same-repository PRs qualify for now; a PR from a fork never starts.
- The review session runs in Copilot CLI's command sandbox with its own Copilot home and no GitHub login (see the
  plan's Phase 0 results). It reads the PR with the helper's `pr-read` and posts only with `pr-review -File
  review.json`. Desktop checks that the loop belongs to the session, the account, that the PR is open and that the
  review names the head Desktop checked out; a review with findings can never approve, and an approval names the head
  and carries no findings. Each post has a receipt that records the head and the base.
- When the author pushes, or the base moves, Desktop brings the reviewer's checkout to the new head (only while it is
  clean) and wakes the session with the last reviewed head, so it reviews the new commits. A marked reply from the
  author wakes it too; its own comments never do. A merge or close ends the loop; Desktop never merges.
- A review loop's approval never ends a fix loop by itself: the PR's own code runs in the same sandbox as the reviewer
  and could post one through the helper, so it shows as **Confirm approval** like any other.
- The worktree shares your project's Git directory, which the sandbox may read but not write: the reviewer can read
  your local history, branches and Git metadata, but not change them. So a review does not start while the project's
  own Git config holds a credential (a remote URL with a token, an http extraHeader, a credential helper set for this
  repository); keep those in your global config or a credential manager. Desktop's own Git commands name the worktree's
  Git directory directly and never follow its `.git` pointer, so nothing the PR's code writes there is run by Desktop.
- Each review is recorded (repository, PR, reviewer, and the folder it will use) before anything is made, so the same
  review cannot start twice. When its loop has ended and its tab is closed, Desktop removes its worktree (only if your
  project still registers it there, and only while it is clean), its ref and its folder; it never prunes your other
  worktrees. A worktree with changes is kept for you, and Desktop says where.
- An approval lists the checks the reviewer ran and the required ones it could not run in the sandbox. With one
  missing, it is posted as a comment instead; say "approve anyway" in the review tab and the reviewer posts the
  approval, after Desktop checks the head and base again.
- When the PR is merged or closed, Desktop tells you if it merged at a head the loop had not approved, or with the last
  review's findings open. Nothing is posted after a merge.
- Known limits: inside Copilot's Windows sandbox, this repository's own esbuild build, its tests and `pnpm install` do
  not run, so the reviewer reports them as not run. A review session started before a restart does not resume into
  its loop; start a new review.
