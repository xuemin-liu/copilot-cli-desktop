# Plan: review loop and fix loop for pull requests

Status: revised after review meeting 29NB; Phase 0 measured (see its results). Later phases are not built yet.

Today the person runs two Claude Code commands for pull requests. `/review-pr` reviews a PR, re-reviews every new
commit, approves only a head with nothing left to fix, and then waits for the next PR. `/fix-pr` watches the author's
own PR, fixes the valid findings, replies on each thread, and stops when the reviewer approves the current head. Both
spend no tokens while they wait, because a script watches GitHub and wakes the agent only when there is news.

This plan builds the same two workflows into Copilot CLI Desktop for Copilot sessions. The desktop does the waiting,
as it already does for [GitHub task follow-ups](workflow-followups.md), and types the news into the session's prompt
when the session is idle. Nothing needs to wake Copilot from outside. The engine, the delivery journal, the checkout
checks and the Tasks UI already exist. What is missing is a role for each side of the PR, a checked way to post to
GitHub, and the rules each role needs.

## What the person does

| Loop | How it starts | What wakes the session | What ends it |
| --- | --- | --- | --- |
| Fix loop (author) | In a task with a PR, choose **Fix review feedback** | A new review, inline comment or conversation comment from an allowed reviewer, other than the session's own replies | A verified approval of the PR's current head and base, a merged or closed PR, Pause, or a limit |
| Review loop (reviewer) | **Review a PR** in the new-session dialog, or **Review this PR** on an existing task | Enrollment (the first review), the author replied on a thread, or the PR's head or base moved | A merged or closed PR, Pause, or a limit. An approval does not end it, because a later commit voids it |
| Next PR (reviewer, optional) | Tick **Then review new PRs** on a review loop | A new open PR by an allowed author, from the same repository | Pause, or the desktop quitting |

The person can run both sides on one computer: one session is the author and another is the reviewer of the same
PR, on the same GitHub account. Waiting costs no model turn and no tokens in either loop.

## Example

1. A session finishes a change and opens PR 284. Its task records the PR. The person chooses **Fix review feedback**.
2. In another project window the person chooses **Review a PR** and picks 284. The desktop makes its own worktree at
   the PR's head, starts a session with the review instructions, enrolls a review loop, and sends the first review.
3. The reviewer session posts two findings through the desktop's PR helper. The fix loop sees them two minutes later
   and types one continuation into the author session. The author session fixes one, disagrees with the other,
   pushes with its own Git under its usual permissions (as task follow-ups do today), and replies on both threads
   through the helper.
4. The review loop sees the new head. The desktop moves its worktree to the new head, then types one continuation into
   the reviewer session. It re-reviews, accepts the reasoning on the second thread, and posts an approval.
5. The fix loop sees an approval that the desktop can verify for the current head and base, ends, and tells the person
   in Needs you. The review loop keeps watching until the PR is merged.

## Decisions

1. **Comments and reviews go through a checked desktop helper, not the session's own `gh`.** A new helper command,
   `copilot-desktop pr`, takes a review, a reply or an approval from the live session that holds the grant. At the
   moment it posts, the desktop checks the grant, the PR's state, head and base, the role, the operation and the
   revision. A review or approval must name the head the desktop checked out for the reviewer. A reply's target is
   fetched first, and it must be a comment on the enrolled PR. An author post must be a reply that starts with the
   marker, and it may not be an approval. The desktop records a receipt for each post (decision 6). The grant records
   the GitHub account id it was enrolled with (`gh api user`), and every post checks that account again. The helper
   never pushes. Continuations tell the session to use the helper and forbid direct `gh` writes.
   - **Reviewer sessions the desktop starts** run inside Copilot CLI's own OS-level command sandbox (Windows
     ProcessContainer), with a Copilot home the desktop owns (`pr-reviewer-sandbox.ts`). Its policy turns off Git and gh
     authentication and the per-command bypass, and denies the person's credential and browser folders, their own
     Copilot home, the desktop's data and the reviewer home itself. The launch adds `--sandbox`,
     `--disable-builtin-mcps` and a deny rule for edits to the reviewer home, and drops every GitHub token variable. The
     desktop does the fetches, and the session reads the PR through the helper. Phase 0 measured this containment
     (below): the agent, and a test script from the PR, reach no GitHub credential, no Credential Manager secret and no
     GitHub tool. The desktop checks the reviewer home's policy before every launch. If the sandbox is unavailable on
     a computer, the reviewer loop posts nothing by itself: each review waits in Needs you with its exact text and a
     **Post** button, and the session must ask before it runs the PR's build or tests. Same-repository PRs by allowed
     authors are the eligibility rule. Enrolling a review loop still asks for its own consent: the session runs this
     PR's build and tests, with network access, in that sandbox.
   - **The fix loop runs in the person's own session**, which keeps its own permissions and credentials, because it has
     to push. Task follow-ups already continue that session unattended, with pushes, today. The fix loop adds only
     replies through the helper, so its write boundary is no wider than follow-ups. Enrolling it is a separate
     consent. It says that the session's own tool permissions govern its edits and pushes, and that, unlike today's
     follow-ups, this loop may post replies on this PR through the helper. A push that loses a race is not forced,
     because the rules forbid `--force`. If the local commits then leave the branch guard unmet (the local head is
     not the PR's head), the loop puts the task in Needs you, because seeing the remote move does not fix the checkout.
2. **The `🤖 ` marker routes comments; it does not prove who wrote them.** On one account, either session or the
   person can write any text. The fix loop drops comments that start with the marker. The review loop takes only
   marked comments from the PR author's account. The marker is stored on the grant and defaults to `🤖 `, the same
   contract the Claude Code commands use.
3. **An approval ends the fix loop by itself only when the desktop can verify it.** That means an approval posted
   through the helper by a reviewer grant on this PR, with a receipt. A formal APPROVED review from an allowed reviewer
   whose account is not the author's is shown, and the person confirms it. Review state is read on its own, not from comment text:
   bodyless reviews count, and a reviewer's state is their latest APPROVED or CHANGES_REQUESTED review, after any
   dismissal. A later COMMENTED review changes neither. A helper receipt records both the head and the base the
   reviewer saw. Before it settles, the desktop fetches the exact GitHub object the receipt names and checks that its
   body still matches what was posted. If the tag was copied, the object was edited or deleted, or the object cannot
   be identified for sure, the person reconciles it. Only a verified receipt, which names both the head and the base,
   settles by itself. GitHub does not record which base an external review saw, so every external approval, formal
   or not, becomes **Confirm approval**, showing the reviewed head and the current base.
   Settlement also waits until the author grant has no queued or uncertain delivery and no uncertain receipt. A plain
   comment `Approved at <sha>`, such as one from a Claude Code `/review-pr` on the same account, also becomes
   **Confirm approval**. It never ends the loop by itself.
4. **Feedback is not lost when the head moves.** Review comments count whatever commit they were posted on (inline
   comments keep `original_commit_id` as their anchor). A queued batch that has not been typed yet is carried to the
   new head, not dropped. Each comment's latest body, author and source are checked again first, and the batch keeps
   its budget reservation. CI events stay tied to the current head. CI is not read at all unless the grant includes
   it, and a failed CI read never holds back review feedback.
5. **The reviewer works in a worktree the desktop owns.** The desktop fetches the PR head into a detached worktree
   that it created. When the head moves, the desktop checks that the worktree is clean and moves it to the new head
   before typing anything. This uses a separate guard for detached worktrees, next to today's branch guard, which the
   author side keeps. A dirty worktree, or one the person attached, gets a Needs you item instead. The grant keeps
   three revisions apart: the head seen on GitHub, the head checked out, and the head last reviewed.
6. **Posts and turns are settled separately.** A delivery marked answered means only that the CLI turn ended. A post
   gets its own receipt: intent is recorded first, then the GitHub id once GitHub accepts it. Each post carries a
   hidden receipt tag, so after a crash the desktop can find on GitHub whether a post landed. If it cannot tell, it
   asks the person in Needs you and never posts again by itself. A post in flight when the grant is paused, expires or
   times out gets the same treatment, and timed-out turns keep today's interrupt and uncertain-delivery protections.
   Closing or merging is read-only: the loop ends and
   Needs you shows the last approved head and whether the merge was at that head. Posting after a merge is not part
   of this plan.
7. **One active grant per PR and role, stored that way.** Uniqueness on repository, PR and role is checked in the
   same transaction that saves the grant. Legacy follow-up grants keep today's one-grant-per-PR rule. The stored caps
   and decoding change together with the runtime limits, and queued reservations count toward the budget, so neither
   a restart nor a double click can create extra turns.
8. **Limits fit a review cycle.** A PR loop keeps three continuations per head. The total is thirty, and Needs you
   offers **Allow ten more** when it runs out. An exhausted budget stops new turns, but the loop still reads approval
   and closure. A turn may run for up to thirty minutes, not ten, because a review runs the build and tests. Polling
   stays at two minutes.
9. **The first review and existing feedback are explicit.** Enrolling a review loop sends the first review at once.
   Enrolling a fix loop asks whether to take only new feedback (the default) or the unresolved feedback already on
   the PR.
10. **The role's rules travel with every continuation.** The first prompt carries the full role instructions, ported
    from the two commands. Every continuation repeats the short rules that must survive a compacted conversation: a
    review with findings never approves, approve only a head you reviewed in full, post only through the helper, and
    read the full PR before deciding because the excerpt is cut.
11. **Each next PR is new work.** A session's permission is tied to its working folder, so every next PR gets a new
    task, session and worktree, started the way **Review a PR** starts one. The desktop keeps a stored set of pending
    PRs, not a single highest number, so PRs that open out of order or qualify later are not missed. A PR qualifies
    only when its author is on the allowed list (by default, the person's own account) and its head is in the same
    repository. A PR from a fork never starts work, because reviewing means running its code.

## Phases

Each phase is one PR, delivered in order. Each one updates [the follow-ups doc](workflow-followups.md) and the README.

### Phase 0: prove the reviewer's containment

- Start a Copilot session the way Phase 3 will, with the reviewer sandbox of decision 1. Using harmless synthetic
  inputs in a test setup, show that the agent's `gh` and `git`, and a build or test script run from the checkout,
  reach no GitHub credential, and that the session cannot loosen its own policy.
- Time a full review turn (build and tests) on this repository, to check the thirty-minute turn limit.
- Exit: a note in this doc with the results. If containment fails, reviewer posts stay person-confirmed and the build
  and tests need approval before they run (decision 1), and the later phases are built that way.

**Results (Copilot CLI 1.0.114, gh 2.98.0, Windows 11 build 26300).** `npm run pr-loop-containment:check` reproduces
the proof below with four short real prompts and passes.

| Measured | Result |
| --- | --- |
| Outside any sandbox (baseline) | gh token, `git credential fill`, gh's hosts file, and 10 GitHub entries in Credential Manager with readable secrets all reachable |
| `--sandbox` with no saved policy | **Not contained.** A masked `GH_TOKEN` is injected and GitHub accepts it through the masking proxy |
| A token in Copilot's own environment, policy with auth off | **Not contained.** `GH_TOKEN` reaches sandboxed commands and GitHub accepts it, so the launch must drop token variables |
| Policy in the repository's `.github/copilot/settings.json` or `settings.local.json`, even in a trusted folder | Ignored, both to tighten and to loosen. Only the Copilot home's settings set the sandbox policy |
| The reviewer setup (desktop-owned home, auth and bypass off, denied paths, tokens dropped), with a loosening PR settings file | Contained: no token variable, gh not signed in, no git credential, no gh hosts, SSH or Copilot home, policy neither readable nor writable, Credential Manager access denied (error 5). Outbound network still works |
| Asking the agent to bypass the sandbox | No unsandboxed option offered |
| Asking the agent to rewrite its policy with the edit tool | Refused by the sandbox's denied path (the deny rule is a second layer) |
| PR settings `enableAllGithubMcpTools: true` | Ignored (5 read-only GitHub tools by default); `--disable-builtin-mcps` leaves none |
| A denied path that does not exist | Every sandboxed command fails, so only existing paths are denied |
| `npm` in the sandbox | PowerShell refuses the `npm.ps1` shim ("AuthorizationManager check failed"); `npm.cmd` works, so reviewer instructions use `npm.cmd` on Windows |

Not covered: other credentials the person keeps in environment variables (such as cloud keys) remain visible to
sandboxed commands, as Copilot's documentation says. The reviewer launch drops only GitHub token variables.

**Timing, and what builds in the sandbox.** A worktree of this repository at `origin/main`, with `node_modules` linked
to the main checkout (a junction) and granted read-only:

| Command in the reviewer sandbox | Result |
| --- | --- |
| `npm.cmd run typecheck` (`tsc --noEmit`) | Passes, about 2 seconds of the turn |
| `npm.cmd run build` | Fails: esbuild, a native binary, cannot read pnpm's junctioned package folders ("Cannot read directory node_modules: Access is denied"), even with the read-only grant and the worktree's parent folders listed in `enumeratePaths` |
| `pnpm.cmd install --frozen-lockfile` in the worktree | Fails: the sandbox refuses to create symlinks (EPERM) |

So the reviewer cannot run this repository's build and tests in the sandbox today. That changes Phases 2 and 3:
the reviewer runs the checks the sandbox can run and reports the rest as not run, never by a bypass (it is turned
off). A head it approves says which checks ran. The desktop never installs or builds a PR outside the sandbox on its
behalf, because install and build scripts are the PR's code. A whole sandboxed review turn with only the type-check
took well under a minute, so the thirty-minute limit is ample; an unsandboxed fix-loop turn that runs the full suite
is the longer case, timed in the Phase 0 PR.

### Phase 1: roles, the PR helper, and the fix loop

- `FollowupGrant` gets `role: 'follow-up' | 'author' | 'reviewer'`, `marker`, the GitHub account id, and the three
  revisions of decision 5. Stored grants without a role decode as `follow-up` and behave exactly as today. Bump the
  schema version with a tested upgrade, and enforce decision 7 there.
- `readGithubPull` keeps comment authors, the PR author, `original_commit_id`, bodyless reviews, dismissed reviews and
  the base sha. It skips CI reads when the grant does not include CI.
- The `copilot-desktop pr` helper with the checks and receipts of decisions 1 and 6, including crash recovery.
- Author role: decisions 2, 3, 4, 8 and 9. The approval check reads review state, not text.
- `githubBatchInput` takes the role, and the author text uses the helper (decision 10).
- Tasks UI: a role choice, the existing-feedback choice, the approval state, and **Confirm approval**.
- Exit: deterministic tests cover a bodyless approval, a dismissed approval, changes requested after an approval, a
  text-only approval on one account (Needs you, not an end), an approval of an older head, a base-only move after the
  approval, a later COMMENTED review, an external approval whose base moved mid-review before the last poll (Confirm
  approval, not an end), a rejected author push that leaves the branch guard unmet, a copied receipt tag, an edited
  receipted post, a reply whose target is on another PR, settlement while a delivery is queued, a queued batch carried
  across a push, a CI read failure, the caps after a restart, a double enrollment, a post in flight when the grant is
  paused, and a crash after GitHub accepted a post but before the receipt was saved.

### Phase 2: the review loop

- Reviewer role: the first review on enrollment; a new head or base counts as news; only marked comments from the PR
  author count.
- The desktop-owned detached worktree and its guard (decision 5). The continuation names the last reviewed head and
  the new one, and says when the old head is no longer an ancestor (a force-push).
- Reviews and approvals go through the helper with the checked-out head as their commit.
- Exit: tests cover a push with no comment, a force-push, a base-only move, a reply and a push together, a dirty
  worktree, a head that moves between the queue and Enter, merge after approval, and merge at an unapproved head. A
  real two-session check runs on a test PR (see Validation).

### Phase 3: Review a PR from the new-session dialog

- The dialog lists the project's open PRs through `gh`. A PR from a fork is refused, with the reason shown.
- The desktop creates the worktree, starts the session (with the Phase 0 rules if the CLI supports them), creates the
  task and enrolls the review loop, in that order. If a step fails, it undoes the earlier steps and leaves the person's
  own checkout alone.
- Exit: tests cover each failing step and its clean-up. The real check starts a review from the dialog.

### Phase 4: new PRs

- **Then review new PRs** keeps the stored pending set of decision 11 and checks it on the same two-minute schedule.
  Each qualifying PR is started as in Phase 3, within the daily and total start limits of automation rules.
- Exit: tests cover a fork, an author not on the list, PRs that open out of order, a PR that qualifies later, and a
  restart while waiting. Pausing stops the queue as well as the loops it started.

## Validation

- Every phase runs the type-check, build and full test suite, and the existing follow-up, delivery and redaction
  tests stay green.
- Phases 2 to 4 need a real check with two Copilot sessions on one GitHub account. It posts real comments, so it runs
  only on a throwaway repository the person creates for it, never on this one. The check is a script in `scripts/`,
  like the meeting checks, and it reports what each session was sent and what it posted.
- The real check runs on the built app with a separate profile folder, not the person's own AppData.

## Not in this plan

- Auto-merge, posting after a merge or close, and reviewing PRs from forks.
- Removing the person's own `gh` credentials from a session they started themselves.
- Claude Code or Codex sessions as the author or reviewer. They can already take part through the marker contract
  with their own commands, but the desktop does not deliver to them here.
- Waiting while the desktop is closed. Like follow-ups, the loops run only while the desktop runs, in the tray too.
