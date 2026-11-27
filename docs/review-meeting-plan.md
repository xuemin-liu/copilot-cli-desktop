# Plan: review meetings with hidden reviewer sessions

Status: agreed in review meeting X4QX (one reviewer, source read only, nothing run). Phases 1 to 3 are built and
released in v0.1.151. Phase 4 was run in two meetings on that release: 3N9F with Claude Code, Codex CLI and
Antigravity CLI as hidden reviewers, and SUZ7 with Copilot CLI. All four CLIs have reviewed as hidden reviewers; they
have not been in one meeting together. Phase 5 is deferred.

Today a review meeting gets its reviewers one at a time: the person tells another agent "join meeting K7QF", or adds
a tab from the desktop. This plan adds a bundled skill, `review-meeting`, that works like `review-and-fix-pr`: the
session the person is talking to hosts the meeting, and the desktop starts one hidden reviewer session for each CLI in
the existing reviewer settings. The reviewers join, answer each round, and are closed when the meeting closes.

## What the person does

1. In any session: "review this plan in a meeting" (or `/review-meeting`).
2. The host starts the meeting with `reviewers: true`. The desktop asks once, naming the CLIs and what they will be
   given. The default answer is to decline.
3. Hidden reviewer tabs start. The bar above the terminal shows the meeting and each seat, with Peek, Retry and
   Dismiss, as it does for pull request reviewers.
4. The meeting runs as meetings do today. When it closes, the hidden tabs are closed.

## What exists and what is new

| Part | Today | New |
| --- | --- | --- |
| Meeting hub, rounds, votes, `meeting_*` tools | In place (`src/main/meeting.ts`) | Opening gate for planned seats; frozen voter roster |
| Joining | Only an existing tab or an outside agent (`meetingHub.join` at three call sites) | The desktop starts a session in order to join |
| Hidden tabs, ReviewerBar, consent, CLI resolution | In place for pull requests (`pr-temp-reviewers.ts`) | Shared launcher; a separate, light group registry for meetings |
| Reviewer settings | `reviewerClis` (global and per workspace), `reviewerAllowAll` | Reused unchanged; wording covers meetings too |
| Bundled skills | Three, names hard-coded in several lists | A fourth, `review-meeting` |

## Agreed design

1. **Surface.** `reviewers: true` on the existing meeting start (MCP `meeting_start`; a helper flag for a Copilot
   host). No separate tool set. Seat state shows in `meeting_status` and the ReviewerBar.
2. **State.** A separate meeting reviewer group registry. The launcher, the hidden-tab lifecycle and the capacity
   accounting are shared with pull request reviewers. One hidden reviewer group per workspace across both start
   paths, with a shared reservation keyed to the resolved workspace, taken before consent is awaited and covering
   pending launches.
3. **Consent.** Explicit, default-decline, once per meeting. It names the configured CLIs, the provider exposure of
   the post, the checkout and the attachments, whether later attachments are covered, and what full access grants,
   including reads and writes outside the launch directory. For a plan-only session it says what the desktop supplies
   and where the session starts.
   Later revision: Settings → Reviewers → "Ask before starting hidden reviewers" (on by default) can turn this question
   off. Pull request reviewers still ask when the pull request is not verified as the person's own or changes
   repo-local CLI/MCP configuration.
4. **Seats.** A managed MCP reviewer (Claude Code, Codex CLI, Antigravity CLI) gets a guest seat the desktop makes
   and grants, and joins with that credential. The seat is tied to the launch generation and revoked on failure, exit,
   dismiss, retry and close. An ordinary join by id keeps its separate grant. Copilot joins directly, only after the
   delivery pump's own readiness.
5. **Readiness and the opening gate.** A seat counts as joined only on a join acknowledgment within a bound; a missing
   route to the meeting tools is a seat failure with its reason. Round 1 opens when every planned seat has joined,
   failed or been dismissed, or the host explicitly proceeds. If every managed seat fails, or the launch is declined:
   the reason is shown, reservations for unused seats are released, and the host has a clear manual-join or retry path.
6. **Roster during a round.** A retried seat joins from the next round. During a vote the voter set is frozen in both
   directions: a managed voter that crashes or is dismissed is recorded as a missing voter and the proposal returns to
   the host to propose again; other new joins, ordinary id joins included, wait until the vote ends.
7. **Copilot delivery.** The managed-seat deadline applies to every delivery, not only the first; a failed seat shows
   in status. Ordinary tabs keep today's behaviour.
8. **Where reviewers run.** A detached checkout pinned to the reviewed commit, its SHA recorded with the approved
   attached changes; the post says what the diff omits. A folder that is not a Git repository, or a repository without
   HEAD, is plan-only: no checkout, the reviewers get the post and the attachment. The detached checkout does not
   protect the workspace (it shares the Git directory, and full access can write anywhere), and nothing says it does.
   Checks that only pull request reviewers need (forge access) are not applied.
9. **Permissions.** The first release uses the person's existing `reviewerAllowAll` setting under the consent in 3.
   Restricted profiles wait for phase 5.
10. **Teardown.** Triggered from the hub's central close path. Idempotent. It cancels pending consent, checkout
    preparation and process start, with a generation and open check after each await and before a spawn. After a
    restart the hidden sessions are gone and are not started again: the restored meeting comes back without them,
    reviewers can join it by its id, or the host ends it and starts a new meeting with hidden reviewers. An
    interrupted start has recoverable area cleanup.

## Failure and security cases

| Case | Behaviour |
| --- | --- |
| A fast reviewer answers before a slow CLI has joined | Cannot happen: round 1 waits for the planned seats (5) |
| A reviewer's process exits mid-round | Its seat is revoked and it leaves the meeting; Retry joins a replacement from the next round |
| A reviewer crashes during a vote | The vote does not pass with a smaller group; the proposal returns to the host (6) |
| No route to the meeting tools for a CLI | That seat fails before or shortly after launch, with the reason |
| The person declines the consent | No seat starts; the meeting stays open for manual joins |
| The meeting closes while seats are starting | Teardown cancels the starts; nothing is spawned after the close (10) |
| A reviewer edits files | "Review only" is instruction text. With allow-all on it is not prevented; the consent says so (3, 8) |
| A blank reviewer tab | Claude Code shows its work only in a project it trusts; Antigravity's print mode is silent. Known, not fixed here |

## Phases

One pull request each. Tests travel with the code they cover.

1. **Desktop core for MCP guest seats** (Claude Code, Codex CLI, Antigravity CLI): group registry and shared workspace
   reservation, desktop-made seats, readiness and the opening gate, frozen voter roster, close-hook teardown,
   ReviewerBar, consent. Checks with stub CLIs: partial launch, close during setup, exit after join, retry, round 1
   gating, vote roster.
2. **Copilot seats**: direct join after delivery readiness, a deadline on every delivery, with stub checks.
3. **The skill**: `SKILL.md`, the provisioning lists, settings wording, documentation, package checks. Only after
   every CLI the settings offer can join.
4. **A real four-CLI meeting**, run by hand and recorded here. Run as two meetings (3N9F with three CLIs, SUZ7 with
   Copilot CLI), not as one meeting with all four.
5. **Later, separately**: restricted meeting profiles, one CLI at a time, entered only where a launch that never
   prompts, cannot write, and can still call the meeting tools has been demonstrated in a pseudo-terminal.

## Test strategy

- Unit tests for the registry, the gate and the roster rules against the real `MeetingHub` with fake timers and
  effects, as `meeting.test.ts` does.
- An Electron check under `scripts/` with stub CLI executables that speak the meeting tools, for the cases listed in
  phase 1 and 2.
- For each fix, a run that shows its test failing without the fix.
- Phase 4 is the only step that uses real reviewer CLIs and the person's accounts.

## Revision notes

- X4QX, round 1: opening gate, desktop-made seats, readiness as a seat check, pinned checkout and plan-only mode,
  teardown and its tests moved into the phase they belong to.
- X4QX, round 2: voter roster frozen in both directions, a deadline on every Copilot delivery, the all-seats-failed
  case. Restricted launch as the default was proposed and deferred: no reviewer had a verified launch for any of the
  four CLIs that never stops at a permission prompt.
- Phase 1, built: the host "explicitly proceeds" by dismissing a seat that is still starting or by stopping the run from
  the bar; there is no separate tool for it. The first round also opens by itself when a seat's join bound (four
  minutes) runs out. A seat's reviewer runs in its CLI's one-shot mode and stays in one turn for the whole meeting.
  Copilot CLI in the reviewer settings is reported as a failed seat until phase 2, and the helper flag for a Copilot
  host comes with it. A voter roster is not saved: a vote restored after a restart counts whoever is back.
- Phase 1, review (three reviewers, five rounds): the permission mode is the run's, not the setting's; a vote whose last
  voter left goes back to the host (an existing rule changed for all meetings: such a proposal is no longer put to the
  next reviewer who joins); a participant not asked in a round is left out of its replies; ending a run takes every seat
  out of the meeting and stops every session before any teardown is awaited; hidden reviewer slots are counted once for
  pull requests and meetings. Known limit, left open: a Retry of a pull request reviewer seat can still race a meeting
  start for the last slot while its old checkout is being removed.
- Phase 2, built: a Copilot seat is an interactive session in the seat's checkout. It gets one first prompt (Copilot
  stores a session only then, and the desktop types only into a session it can prove is this one), and the desktop
  joins it once the delivery pump would accept a message. Starting does not wait for that join, so the other seats are
  not held up. A message that cannot be typed into it for three minutes takes the seat out of the meeting with the
  reason; its tab stays for Peek. A Copilot host asks for reviewers with `start -Reviewers` on the meeting helper.
- Phase 2, review round 1: the delivery deadline of a Copilot seat asks what the hub asks, so a message that was typed
  and never recorded takes the seat out too; the first prompt is marked as the desktop's turn (it authorizes nothing),
  and the seat joins only when the conversation it was typed into has recorded it; a tab that changes conversation
  fails or leaves its seat with that reason; the consent names Copilot's model provider; the helper's `status` lists the
  hidden reviewers.
- Phase 2, review round 2: a Copilot seat that took a message and never ends that turn (a permission prompt with
  allow-all off) is not covered by the delivery deadline, which does not count a message waiting behind a running turn.
  So a hidden Copilot seat goes by the hub's rule for the other hidden seats: two rounds in a row without a reply take
  it out, each of those rounds running to its timeout. An ordinary Copilot tab is still the person's to judge. A seat is
  the conversation its launch started: a tab that changes to another one before the first prompt fails the seat.
- Phase 3, built: the `review-meeting` skill is provisioned with the three pull request skills (the same list, the same
  marker and backup rules), and `pr-poll.mjs --guide review-meeting` prints it for a CLI that did not find it. Settings
  says "Reviewers" for the CLI list and "hidden reviewer sessions" for the permission switch, since both now serve
  meetings too; messages that name those settings were changed with them.
- Phase 1 limit, corrected (meeting 3N9F): the Retry of a pull request reviewer seat checks for a free slot before its
  cleanup and does not check again after it, so when a meeting start takes the last slot in between, whichever launch
  reaches `createBackgroundTab` second fails there. A reservation held through the cleanup would decide it once; not
  built.
- Phase 4, run: meeting 3N9F on the installed v0.1.151, hosted by a Claude Code session through the `review-meeting`
  skill and the meeting tools. The consent was answered by the person; Claude Code, Codex CLI and Antigravity CLI were
  started as hidden reviewers, all three joined, round 1 opened once they had, all three replied, and all three agreed
  to the proposal in round 2, which closed the meeting. Their checkouts were removed with it. Copilot CLI was not among
  the configured reviewers, so a Copilot seat and a Copilot host were not part of this run.
- Agreed in 3N9F, not built yet: Electron fixture checks for a hidden Copilot seat that is silent for two rounds, one
  whose tab changes conversation (after joining, and while its first prompt's recipient is being verified), and a
  Copilot host using `start -Reviewers`. Left for a later phase: starting hidden reviewers for a meeting that is
  already open, which would also cover a restored meeting.
- Phase 4, second run: meeting SUZ7 on the installed v0.1.151, hosted by a Claude Code session, with Copilot CLI as the
  one hidden reviewer. It was started after the person's consent, primed and joined by the desktop, reviewed round 1
  from its own checkout, and agreed to the proposal in round 2, which closed the meeting.
- After 3N9F, built: `scripts/review-meeting-copilot-paths-check.mjs` (real Copilot CLI, mock model). A Copilot session
  hosts with `start -Reviewers` (consent once, the seat's review typed into the host, the helper's `status` listing the
  seat, `end`); a joined seat whose tab is switched to another conversation with `/resume`; a seat that takes its
  message and never answers, taken out after two rounds without a reply. Still not covered: a switch while the first
  prompt's recipient is being verified.
- What the switch case showed, agreed in SUZ7: with both conversations retained by the CLI the tab keeps its session id
  and its binding is not delivery-ready, so the next round is not typed anywhere and the delivery deadline takes the
  seat out (three minutes by default). `onMeetingCopilotSeatSwitched` did not fire there; whether it fires on a switch
  that drops the old conversation is untested. The seat is not taken out sooner on such a binding, because a passing
  failure to list the store looks the same, and closing the other conversation within the three minutes restores
  delivery.
- Both Electron checks asserted the consent question the moment the start answered, though the run asks only once its
  commit is known; they wait for the question now. That was the "zero consent prompts" failure reviewers saw at times.
