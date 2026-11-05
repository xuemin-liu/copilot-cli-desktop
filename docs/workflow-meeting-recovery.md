# Meeting handoffs and journal recovery

Local meeting prompts now share the workflow journal and destination arbiter with GitHub task follow-ups and
rule-created tasks. Each new meeting prompt has a stable UUID stored in its existing version-1 meeting snapshot.
The outbox waits for that snapshot to be written, verifies the current CLI recipient, and commits journal intent
before pasting. The journal holds an app-defined summary, never an executable copy of the proposal. The meeting's
original text is delivered unchanged within its existing meeting-size caps; credential-like code identifiers are
not rewritten by audit redaction. It checks authorization again before delayed Enter. Drafts, pickers and held person input retain
the same protection as other desktop-composed tasks. Idempotent `/add-dir` setup retains the existing command path;
an unresolved workflow submission blocks that path too.
Identity changes are distinct from a temporary inventory failure: ordinary manual submissions preserve their Enter and
held keys when identity is unchanged, while automatic meeting/rule hooks still require a verified recipient before Enter.

An observed matching live desktop turn can supply a meeting reply. The journal marks it answered only after the
meeting's reply/round snapshot has finished writing. A write failure, native session switch, interrupted turn,
closed process or restart leaves possibly submitted input uncertain. A manual prompt cannot answer an automatic
meeting turn. The person can inspect the linked session and choose Send again or Discard in Handoffs. Discarding a
handoff does not manufacture a reviewer reply; the meeting keeps its normal timeout/person controls.

Typed input can also be lost without any error: in meeting W7A4 the post was submitted, but the reviewer's CLI never
recorded it, and the person's later "why are you stuck?" turn was taken as the reply. A Desktop-typed prompt is now
confirmed only by a recorded `user.message` whose text matches what was typed (or carries the meeting marker or an
older CLI's paste placeholder). A non-matching prompt is the person's: it settles the expectation and leaves the
delivery uncertain. If no matching prompt is recorded within 60 seconds, the delivery also becomes uncertain and the
session's later turns are not attributed to it. Uncertain deliveries are never typed again automatically.

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
Closed meeting scopes are retired when the in-memory outbox has no work and no turn is still running. An entry left
uncertain is discarded then: a closed meeting takes no more replies, so it can no longer matter, and keeping it would block
that session from every later meeting. In an open meeting uncertain evidence is retained, and the meeting bar and a
notification say so. Storage failure disables automatic meeting input while ordinary terminals remain usable.
An individual intake rejection is shown as a waiting handoff and leaves other destinations and recovery actions usable;
it is distinct from an unavailable/corrupt journal.

A message that cannot be typed is never silent. After 15 seconds the person gets one notification and the meeting bar
says which session and why: text in its prompt box, an open session picker, a second session held by its CLI, an earlier
handoff awaiting a decision, a menu or dialog possibly open. A prompt recalled from history holds nothing the person wrote,
so after 5 quiet seconds the desktop clears it with Ctrl+C. Right after a command a dialog may have the keyboard, and typed
text would go into it, so nothing is typed until the prompt's footer is the last thing on screen. A round does not time out
while a reviewer's message is waiting to be typed, or was typed and never confirmed. One waiting behind a running turn does
not hold the round, and is reported after 5 minutes.

Validation uses real SQLite reopen/retry/discard tests, legacy identity fixtures, existing meeting/guest round tests,
and production lifecycle fixtures for recipient switching, no-lock initial delivery and draft/Enter protection.
No live model or production meeting is required for the fixtures.

This finishes the local meeting migration in Phase 3 of the [workflow plan](task-workflows-plan.md), following the
[journal foundation](workflow-deliveries.md), [task follow-ups](workflow-followups.md) and
[preview rules](workflow-automations.md).
