# Durable automatic handoffs

`WorkflowDeliveries` is the host-owned outbox for the event-driven workflow PRs following task tracking. Desktop opens
its separate SQLite file at startup and exposes unresolved records in Handoffs. This foundation does not enroll a
repository, start source polling, or replace the existing meeting transport; those integrations need their own PRs.

The caller must deduplicate source revisions, verify the grant and live recipient, then call `begin` immediately
before input can be submitted. `begin` durably commits intent. `submitted` records that input was sent; it does not
prove the CLI consumed it. Only positively correlated runtime evidence may call `answered`. A busy input gate may
call `notSubmitted` only if it proves nothing was typed. Exceptions and ambiguous results must become uncertain.

On restart, submitting/submitted work becomes uncertain. It blocks further automatic delivery to the same session
until the person inspects the session and chooses Send again or Discard handoff. Source events and worker reports
cannot make those choices. Queued work retains its identity, and the same source/revision/scope/session tuple cannot
create another delivery. A scope cancellation removes only queued work; interrupting an already running worker is
the caller's responsibility. An explicit retry still needs current authorization before it can begin.

Use one host owner for this database. SQLite transactions and a uniqueness constraint enforce one unresolved
submission per session. All text is normalized and credential-redacted before it reaches disk; invalid persisted
records stop delivery. The store caps history at 1,000 records and refuses new intake rather than discarding unresolved
evidence or silently losing deduplication. A future retention change must preserve source revision tombstones.

Validation includes abrupt process exit after committed intent, reopening after both submission boundaries,
per-session blocking, explicit retry/discard, permission rechecks, immutable deduplication, and credential masking.
