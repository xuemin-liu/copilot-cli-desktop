# Meeting handoffs and journal recovery

Local meeting prompts now share the workflow journal and destination arbiter with GitHub task follow-ups and
rule-created tasks. Each new meeting prompt has a stable UUID stored in its existing version-1 meeting snapshot.
The outbox waits for that snapshot to be written, verifies the current CLI recipient, and commits journal intent
before pasting. It checks authorization again before delayed Enter. Drafts, pickers and held person input retain
the same protection as other desktop-composed tasks. Idempotent `/add-dir` setup retains the existing command path;
an unresolved workflow submission blocks that path too.

An observed matching live desktop turn can supply a meeting reply. The journal marks it answered only after the
meeting's reply/round snapshot has finished writing. A write failure, native session switch, interrupted turn,
closed process or restart leaves possibly submitted input uncertain. A manual prompt cannot answer an automatic
meeting turn. The person can inspect the linked session and choose Send again or Discard in Handoffs. Discarding a
handoff does not manufacture a reviewer reply; the meeting keeps its normal timeout/person controls.

On upgrade, outstanding prompts in old meeting files lack submission receipts. Desktop creates a bounded-format
recovery identity deterministically from the meeting, durable recipient, round, kind and body. Such a prompt becomes
uncertain and needs a person's decision before replay. Repeated restarts preserve the same identity and decision.
A redacted `meeting.pre-journal.json` backup is written atomically before the first old snapshot is upgraded. The
meeting format remains readable and its existing rounds, roles, guest seats and timeout semantics are retained.
Older Desktop releases do not consult this journal; downgrading cannot preserve the new resend guarantees.

Guest delivery continues to use its existing durable, authenticated mailbox rather than PTY input. A local uncertain
delivery blocks competing automatic input even when its source was a meeting. Global/project pause stops future local
meeting dispatch and requests interruption only when the same live session is still the recipient. A native session
switch invalidates the old delivery; it does not authorize Ctrl+C against the newly bound conversation.

Queued handoffs can be inspected and discarded, including when a crash left a queue entry without a restored meeting.
Closed meeting scopes are retired only when the in-memory outbox has no work and every journal entry is terminal.
Unresolved evidence is retained. Storage failure disables automatic meeting input while ordinary terminals remain usable.

Validation uses real SQLite reopen/retry/discard tests, legacy identity fixtures, existing meeting/guest round tests,
and production lifecycle fixtures for recipient switching, no-lock initial delivery and draft/Enter protection.
No live model or production meeting is required for the fixtures.

This finishes the local meeting migration in Phase 3 of the [workflow plan](task-workflows-plan.md), following the
[journal foundation](workflow-deliveries.md), [task follow-ups](workflow-followups.md) and
[preview rules](workflow-automations.md).
