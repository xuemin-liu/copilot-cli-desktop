# Plan: tasks, attention, and automatic follow-ups

Status: every planned acceptance item has implementation coverage in the stacked feature PRs. Integrated validation,
current-revision review and merge status remain separate gates. See the [implementation coverage](workflow-implementation-coverage.md).

Copilot CLI Desktop already runs multiple sessions, creates worktrees, shows live activity, and coordinates review
meetings. The next step is to keep track of what those sessions are trying to deliver and bring the person back only
when a result or decision needs them. This plan borrows workflow ideas from DeepSeek's SuperAgent prototype and adapts
them to our desktop app. It covers all five ideas: a Needs you view, task outcomes, review/CI follow-ups, durable
handoffs, and automation preview.

## What the person does

Phases 1–3 (Needs you, task outcomes, and durable handoffs) work without setting up a bot or writing automation rules.
Phase 0 verifies integration capabilities. Automatic work from GitHub events requires an explicit opt-in. Nobody has
to copy review messages between sessions or restart a workflow after every turn.

| Capability | Built-in behavior | Person's involvement |
| --- | --- | --- |
| Needs you | Collect approvals, questions, reviewable results, and failures across open projects | Open the relevant session and answer or review; no setup |
| Task outcomes | Link a request to its session, worktree, meetings, and optional PR; update status from evidence | Start work normally; clarify only when the outcome is unknown |
| Durable handoffs | Save pending deliveries and reconcile after restart | Nothing in ordinary operation; decide whether to retry an uncertain delivery |
| Review/CI follow-ups | Watch selected PRs and continue their tasks when an enabled rule matches | Opt in for a task, or explicitly enroll tasks under a project default; answer scope/design questions |
| Automation preview | Show which tasks an event rule would start, with its reason; enabled rules can start work | Choose a rule, inspect its previews, then enable automatic execution |

Approving automatic follow-ups does not approve every tool action. Existing Copilot permissions, app approvals, Git
protections, and desktop-control restrictions continue to apply. There is no automatic merge in this plan.

## Example workflow

1. The person starts "Fix checkout rounding" in a new worktree, as today, and submits the request. Desktop creates a
   task linked to that session. Merely pasting a draft or using fan-out does not start work.
2. The session works. The sidebar still shows tools and activity. A task report says the change is ready for review
   and records the checks actually run. Needs you shows the result and links to its diff or review meeting.
3. The person associates the task with its GitHub PR and enables "Continue on allowed review feedback and failed
   checks". The UI shows the repository, PR, accepted reviewers, scope, limits, and selected session before enabling.
4. A relevant review arrives. Desktop saves the event, checks the grant and current task revision, and queues one
   follow-up to that task. The session takes it only when its prompt is idle, empty, and safely bound.
5. If the feedback asks for a broader redesign, the worker reports a question. It does not create a wider mandate.
   The person answers in the existing conversation. Repeated CI failures stop at a configured limit and appear in
   Needs you instead of causing an endless fix loop.
6. If Desktop restarts, it restores the task and reconciles pending work before continuing. Closing or pausing the
   task stops automatic continuation. The person completes the task after reviewing the result, or an explicitly
   configured PR-merge completion condition completes it when verified against current GitHub state.

GitHub watching runs only while Desktop is running, including when its window is hidden in the tray. Quitting the
app stops it. On the next launch, bounded catch-up checks the current source state before acting on missed events.
This is not a promise of a separate always-running service.

## Current foundations and boundaries

| Existing component | Reuse | Boundary to preserve |
| --- | --- | --- |
| `src/main/session-activity.ts` and `session-permission-monitor.ts` | Read live turn/tool activity and session identity | Idle, process exit, and old log replay do not prove a task succeeded |
| `src/main/session-task.ts` | Gate desktop-composed input on an idle, empty, quiet prompt | Never overwrite a draft, type into a picker, or submit to an ambiguously bound session |
| `src/main/meeting.ts` and `meeting-delivery.ts` | Task-related reviews, saved outstanding messages, serialized delivery | Meetings already recover; preserve round/role semantics while adding delivery identities |
| `src/main/session-worktree-launch.ts` and worktree cleanup | Dedicated checkout and session launch | Keep current cleanup protections; a task reference must not allow automatic deletion of work |
| `src/main/main.ts` notifications and session event wiring | Route attention to the correct tab/window | Coalesce notifications; reopening the app must not repeat historical notifications |
| Session history, restored tabs, and usage ledger | Find linked sessions and display recorded usage | Stable task identity survives a tab/process change; unknown usage stays unknown |

These are starting points, not proof that every needed CLI event exists. Phase 0 checks the required integration
surfaces against supported CLI versions before any automatic dispatch is shipped. Remote sessions may show known
attention, but this plan does not deliver local editing tasks into them. Existing restricted side chats remain restricted.

## Shared model

### Task, execution, and outcome

A task has a stable ID, title, original submitted request, project/repository identity, scope revision, origin,
linked session IDs, optional worktree/branch and PR identities, creation/update times, and recorded reports. A tab ID
is a presentation reference, not the task's durable identity. Starting a new conversation in a tab does not silently
transfer its old task or automation grant. A normal submitted request creates a task only when the verified session
has no active task; later turns continue that task unless the person explicitly starts another. No model is called
to classify every prompt. Existing/restored sessions are initially untracked and can be adopted explicitly.

Fan-out creates one task per submitted worker with a shared comparison group. Two workers must not claim ownership
of the same task. A task has at most one worker turn in flight; a replacement requires verifying that the old owner
has stopped. A review meeting links to the task and reports review progress; agreement alone is not task completion.

Store the task's outcome separately from process lifecycle and turn activity:

| Task status | Evidence and transition |
| --- | --- |
| Unknown | No reliable outcome report; also used for unsupported integrations or ambiguous recovery |
| Working | Verified live work or an accepted queued continuation; show queued vs running separately |
| Needs input | A structured question or permission requirement; retain the previous outcome underneath an approval overlay |
| Ready for review | A scoped report names the result and its validation; it is a request to review, not proof of correctness |
| Blocked / failed | A report identifies the obstacle, a launch fails, or an execution limit is reached |
| Completed | The person marks it complete, or a previously enabled completion condition is verified |
| Cancelled | The person stops the task; events cannot resume it without a new explicit grant |

A final assistant message, successful command, quiet terminal, or zero exit code cannot independently mark the task
ready or completed. A cancelled process does not imply lost work. Keep last known outcome, current activity,
attention reasons, and suspension state separate so a temporary approval does not erase a reviewable result.

### Structured task reports

Add a versioned task-report helper through the existing authenticated local control-server pattern. Reports contain
task ID, assignment ID, scope revision, report kind, bounded summary, optional question, artifact references, and
validation entries (`passed`, `failed`, `not run`, with command/check identity and revision where available).

The host binds the helper to the verified managed session/process and current assignment; model-provided task IDs or
terminal text cannot authenticate a report. Use session-scoped credentials through the app's protected local helper
configuration, never through a prompt or transcript. Validate lengths, kinds, revisions, and ownership in main.
Reports cannot start other tasks, broaden scope, alter permissions, enable automation, or mark completion on their own.
Links and paths remain untrusted data until a user action passes existing navigation/path checks.

Inject the reporting instructions when a task-capable session starts. Older sessions/CLI versions without a verified
reporting surface keep existing terminal behavior and show outcome Unknown; offer Resume with task support. Do not
parse natural-language summaries as authoritative commands. Manual outcome changes remain available.

### Workflow text and credentials

Treat requests, task titles, report summaries, questions, validation labels, artifact URLs, and GitHub event/review/CI
text as untrusted and potentially credential-bearing. Redact workflow-owned copies in main before persistence or
display, including task records, event summaries, delivery text, previews, attention cards, IPC, diagnostics, and
exports. Reuse `redactDiagnosticText` and the existing credential-masking conventions; bound and clean text as well.
Persist command/check names as redacted labels, not full command lines with arguments. Do not capture raw CI logs,
source payloads, or an unredacted backup alongside a sanitized record. Failure diagnostics must not log rejected raw
input. This requirement applies to workflow-owned data; it does not rewrite the CLI's existing transcript.

Use source IDs and revisions to retrieve additional context through existing permission checks when needed; a
redacted display/audit summary is not an executable command. Masking is best effort, so minimize stored text and do
not describe it as a guarantee that arbitrary secrets can be detected. OS notifications contain only a bounded,
redacted task title (or a generic fallback) and an app-defined reason such as "Needs approval" or "Ready for review".
Never include request, question, report, review, CI, or command text in a notification body or title.

### Attention

Attention is a projection of existing approval state, task reports, meeting state, and delivery/source failures.
Deduplicate by task/session and reason, order actionable failures/approvals/questions before ready-for-review results,
and show the action and reason, not a generic red dot. A task can have several reasons without several duplicate cards.
Include open projects even when they are not selected; do not start dormant sessions just to populate the view.

Acknowledging a card records that it was seen; it does not resolve the underlying approval or question. New report or
revision evidence can reopen attention. Notify once per new actionable state while backgrounded, coalesce bursts,
and honor current notification settings. Show unsupported or unavailable state honestly rather than guessing.

### Grants and rules

Two paths can authorize automatic work:

- A task follow-up grant names one task, repository/PR, allowed event kinds, allowed reviewer identities, scope
  revision, execution permissions, and limits. A project default is a template offered for new tasks; it does not
  retroactively enroll existing tasks. Enrollment is visible and can be disabled per task.
- A project automation rule may create new tasks from explicitly selected event kinds and repositories. It names
  eligible actors, a bounded task template, execution settings, concurrency/budget limits, and a versioned mode:
  Off, Preview, or Automatic. A new rule starts in Preview. Only a person can promote it to Automatic.

An event is evidence under a grant, never authority to change that grant. Reviewer text, CI logs, repository files,
and agent reports cannot enable rules, widen scope, add reviewers, or change the launch profile. Identity matching
uses canonical GitHub IDs/types, including explicit handling of bot accounts, rather than display names.

Recheck task state, ownership, grant/rule revision, repository identity, and permissions immediately before every
launch or delivery. A grant change invalidates queued authorization. Disabling a grant cancels its pending deliveries
and requests interruption of an active automatic turn using the supported stop path; show stopping until confirmed.
Effects already performed are not undone. Pausing persists across restart and follow-ups; resumption needs a person.
While paused, retain bounded event history and re-evaluate current state on resume instead of blindly replaying it.

Task follow-ups do not need a routing model: the task-to-PR association determines the destination. If an event could
belong to several tasks, offer a choice and do not dispatch it twice. Suggested new work stays separate from existing
task ownership. An out-of-scope request becomes a suggestion/question, not an automatic scope expansion.

### Durable delivery

Use a dedicated versioned workflow store under userData, separate from settings and usage accounting. A small SQLite
store can atomically persist task state, accepted events, decisions, and intended deliveries before any external
action. Validate schema versions, serialize writes, and fail closed on write/corruption errors while leaving ordinary
manual terminal use available. Do not promise exactly-once execution through PTY input.

Each delivery has a stable ID, task/assignment/destination identity, source event versions, scope/grant revision,
attempt count, and state: queued, submitting, submitted, acknowledged, answered, cancelled, failed, or uncertain.
Persist submitting before typing. Submission success is not proof the CLI consumed the message. An acknowledgment
must come from a verified live turn/helper correlation, never a matching text fragment in historical output.

After a crash, compare durable delivery evidence with the correctly bound session's new/persisted turn records:
retry only proven unsubmitted work, advance positively correlated work, and put ambiguous submission in Needs you.
An uncertain delivery blocks later automatic input to the same destination until reconciled or explicitly dismissed.
No automatic resend of a possibly executed command. Retries of pre-submission failures use bounded backoff; invalid
permissions, wrong identity, and ambiguous ownership wait for a person instead of retrying indefinitely.

Use the existing idle/empty-prompt gate for PTY delivery. Do not bypass the meeting live-person-turn guard to launch
automation: automatic assignments need a distinct host-validated origin and grant, kept separate from human-turn
provenance. A task report from such a turn cannot impersonate a new person request or authorize a meeting start.

## Phases and acceptance criteria

Each phase is a separate implementation PR with its own validation evidence. The documentation PR approves a direction,
not an assertion that untested CLI capabilities or later phases already work.

### Phase 0: verify CLI integration and recovery evidence

- Probe supported CLI versions for submitted human turns, managed session identity, turn boundaries, helper invocation,
  and any stable correlation metadata usable for delivery acknowledgment. Use disposable profiles and a loopback model.
- Exercise native session switching, a restored/unloaded tab, a side chat, simultaneous user typing, and a crash at
  submission. Record which cases are provable and which must remain uncertain.
- Define a capability flag per integration, with an explicit fallback. A CLI upgrade with unknown event shapes does
  not silently enable dispatch. Prefer an official correlated API when actually available; do not assume one exists.

Exit: an evidence table, supported-version policy, and fixture captures with secrets/prompts removed. If submission
cannot be correlated safely, automatic delivery remains disabled for that path; task tracking and attention can ship.

### Phase 1: Needs you from existing facts

- Add the cross-project view, grouped reasons, navigation, unread state, and notification coalescing.
- Initially use existing approvals, meeting questions/status, and process failures. Show task questions/results only
  once Phase 2 provides reports. No new model calls or GitHub access.
- Preserve sidebar ordering preferences, accessibility, pop-out navigation, and dormant-session behavior.

Exit: a failed session, pending approval, and waiting meeting each produce the correct single actionable entry;
clearing the source state clears its reason; restart does not re-notify old evidence. Include renderer fixtures and
an isolated real-Electron check with screenshots, including multiple projects and a popped-out session. Notification
fixtures verify that only the redacted title and app-defined reason reach the OS notification API.

### Phase 2: task records and outcomes

- Add the workflow store, task/session/assignment binding, validated report helper, and task details with artifacts,
  validation, linked meetings/worktree, and manual Complete/Cancel controls.
- Create records automatically for verified first submitted work in supported sessions. Preserve unsubmitted drafts,
  fan-out semantics, and explicit adoption for old conversations. New task starts are explicit within an active task.
- Show process activity separately from task outcome. A paused/closed session leaves its task discoverable.

Exit: an ordinary new task is tracked without extra setup; a worker can report ready, blocked, or a question; forged,
stale, oversized, and foreign-assignment reports are rejected; idle/exit/replay never imply success. Restart, session
switch, worktree deletion, and tab closure keep stable identity and expose missing resources without recreating them.
Use synthetic credential-bearing request/report/title/question/validation/URL fixtures to verify redaction before
workflow persistence and presentation, including attention/IPC/diagnostics/exports and rejected-input errors. Inspect
stored records and outward payloads, not only rendered text; notifications expose no report or question content.

### Phase 3: durable handoffs

- Implement the delivery journal and recovery contract above. Give meeting deliveries stable IDs and migrate them
  incrementally, preserving outstanding rounds, guests, timeouts, and existing saved meetings.
- Serialize all automated input to a destination, including meeting delivery, through a shared arbiter. Manual input
  and drafts keep precedence. Never mix a task continuation with an in-flight meeting turn.
- Migrate versioned state transactionally with backups; retain a readable recovery path. Ordinary terminal launch
  remains usable if the workflow store is unavailable, while automatic delivery stays disabled.

Exit: crash-injection tests at each persistence/typing/acknowledgment boundary demonstrate no silent loss and no
automatic duplication of uncertain work. Existing meeting restore/binding/guest checks still pass. A person can
inspect an uncertain delivery and retry or dismiss it with the ambiguity clearly shown.

### Phase 4: review and CI follow-ups for an existing task

- Add explicit PR association and opt-in UI. Require GitHub CLI availability/authentication for this feature only;
  explain missing access without blocking local work. Validate repository and PR identity through GitHub.
- Poll only enrolled PRs and necessary current check/review state, with pagination, bounded concurrency, backoff,
  rate-limit handling, and persisted cursors/event versions. No public listener or webhook is required.
- Snapshot head/base and feedback versions consistently; if they change during collection, retry the observation.
  Record edited/deleted comments, superseded reviews, check reruns, and force-pushes without treating old feedback
  or old green checks as evidence about the new head. GitHub-unavailable, checks-pending, checks-absent, and passed
  are distinct states. Revalidate current state before dispatch; omit obsolete events with a recorded reason.
- Batch related feedback into one bounded follow-up. Deduplicate task/event/version work, ignore our own unchanged
  recorded replies, and never turn a completion report into another trigger. Unknown actors produce no execution.
- Default to at most one active continuation per task, two active automatic workers per project, and three automatic
  continuation attempts per PR head. A new head does not reset a task's explicit total limit of ten continuations
  per enrollment; exhausting either limit requires a person. Enforce a ten-minute active-turn limit through the
  supported interrupt path and surface failure to stop. Track queued work separately from these active limits.
  Preserve any stricter session credit/continuation limits; cost unknown to the app cannot be described as capped.
- Do not post GitHub comments or enable merge as part of source polling. Worker writes remain subject to the original
  task grant and permissions. Revoked access, closed PRs, cancellation, or a disabled grant stops future dispatch.

Exit: one eligible review/check event wakes the intended worker once; busy prompts queue safely; edits/reruns and
network/restart races reconcile correctly. Bots, duplicate events, paused/completed tasks, unrelated PRs, and
out-of-scope requests do not start work. After completion, new feedback requires explicit reopening/re-enrollment.
Use mocked GitHub fixtures and the local model; any live GitHub smoke check uses an explicitly selected test PR.
Feed synthetic credential-bearing review/CI/event text through ingestion, persistence, queued delivery, preview, and
attention paths. Assert that secrets and raw payloads do not survive in workflow records, diagnostics, or outward UI
payloads, and that notifications contain only the redacted title and app-defined reason. Phase 5 reuses these checks
for rule-created tasks and previews.

### Phase 5: preview and rule-based task creation

- Add a small set of bounded built-in templates first: suggest an investigation for a failing default-branch check,
  or suggest work on a newly assigned issue from an allowed actor. No arbitrary executable rule language.
- Off collects nothing for that rule. Preview records a bounded event summary, matched rule version, intended scope,
  and reason; it launches no model/worker, creates no checkout/PR, and sends no external message. Automatic starts
  a task only for new eligible events after the rule's activation boundary.
- Promoting or editing a rule does not execute its backlog. A person can explicitly start a selected preview after
  the app revalidates current state. Editing execution scope/settings returns the rule to Preview and cancels stale
  pending decisions. Existing active tasks require explicit re-enrollment under the new scope.
- Reuse the task store, delivery journal, limits, attention view, and permission model. Deduplicate by repository,
  source identity/version, and rule revision; also detect an existing task for the same issue/check before launching.
  Two matching rules cannot create two workers for the same work without an explicit user decision.
- Show preview history and controls to pause a rule, a project, or all automatic work. A global pause persists over
  restart and takes precedence over per-task/project settings.

Exit: previews explain decisions without side effects; activation starts only subsequent eligible work; rule edits,
overlap, duplicate events, pause/restart, exhausted limits, and already-owned work cannot cause duplicate launches.

## Validation and release

Test state transitions and race boundaries, not labels alone. Required implementation coverage includes report
authentication, native session rebinding, old-log replay, cancellation before/after queuing, draft preservation,
duplicate delivery, crash recovery, source pagination/version changes, reviewer identity, rate limiting, and permission
revocation while queued or active, plus credential redaction before persistence and presentation. Use explicit barriers
for races and an isolated profile/loopback model for Electron
checks; avoid paid model requests in routine regression runs. Run typecheck, relevant unit tests, and existing meeting,
binding, fan-out, and worktree checks when their paths change. Confirm the docs-only PR with diff/link checks.

Ship attention and task tracking first. Ship durable delivery before enabling event-driven execution. GitHub watching
and rule-based execution remain opt-in; use capability gates rather than hidden fallback behavior. Do not add an
always-running router model. Store workflow data locally with bounded retention: at most 1,000 event summaries per
project and 30 days of preview history; prune unreferenced entries first, retain unresolved/pending evidence, and stop
new intake with attention if the cap cannot be respected safely. Completed-task retention and explicit deletion must
preserve linked files/worktrees and make clear which local history is removed.

Review each phase against: can a person tell what needs them, why work started, which scope allowed it, what evidence
supports its outcome, and what will happen after restart? Record actual checks and limitations in each implementation
PR. The initial release criteria are reduced manual handoffs and explainable state, not a claim of autonomous success.

## Review decisions proposed by this plan

1. Needs you, task tracking, and recovery are built in; starting new external-event work requires opt-in.
2. New sessions get tasks from verified submission; old sessions are adopted explicitly and unsupported ones stay Unknown.
3. A task outcome and a running/idle process are different facts; ready-for-review reports do not complete tasks.
4. Automatic continuation stays with the original task/session/worktree and needs a host-enforced grant.
5. Uncertain PTY submission waits for reconciliation instead of resending automatically.
6. Project defaults enroll only explicitly accepted new tasks; new rules start in Preview and activation has no backlog.
7. Manual input, cancellation, permissions, and persistent pause always take precedence over automatic work.

## Sources

DeepSeek's public repository labels its code a research prototype, not production-ready software; these references
inform the design rather than establish guarantees about our implementation. Consulted 2026-11-02.

- [SuperAgent overview](https://github.com/deepseek-ai/dsh-superagent-prototype): overall scope and prototype limitations.
- [Philosophy](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md): conserve human
  attention and communicate when a result or decision needs a person.
- [Panel](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/005-panel.md): prioritize work needing a person.
- [Execution](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md): task stages,
  event-based continuation, and recovery.
- [Authorization](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md): scope,
  explicit requests, written rules, and observe mode.
- [Architecture](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md): durable
  state and queued effects before external execution.
- Existing Desktop plans: [agent workbench](agent-workbench-plan.md), [review meetings](session-meeting-plan.md), and
  [outside meeting reviewers](meeting-guests-plan.md).
