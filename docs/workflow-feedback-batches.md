# Bounded feedback batches

Eligible new review/CI feedback for one task, enrollment and current PR head is grouped into continuations of at most
ten source versions. A batch has bounded, redacted excerpts and source references so the worker can refresh additional
context through its existing permissions. Each group uses one continuation reservation: the limits remain three per
head and ten per enrollment, with the existing worker/time/permission/input gates. No routing model or GitHub write
is added.

The delivery journal stores a batch's head, canonical source/version membership and stable reservation together with
its queued intent. Provider order and display text do not change its identity. Before dispatch every member is checked
against one fresh source snapshot. A changed head cancels obsolete queued work. Deleted, edited or no-longer-eligible
members cause a transactional replacement of only proven unsubmitted work; unchanged eligible references remain
deliverable. A version already reserved elsewhere is not duplicated. Reconciliation preserves the reservation, so it
does not create another model attempt. Submitted and uncertain messages are never automatically rebuilt or resent.

Durable reservation/source pairs recover intake deduplication and consumed limits if a process exits between the
journal commit and grant update. Ambiguous execution still requires the existing person-only retry/discard controls.
Inconsistent duplicate provider versions back off instead of creating a partial observation.

Journal schema v2 adds atomic source metadata with a readable v1 backup and retains existing meeting states/recovery.
Validated journal views are cached, invalidated after writes or external SQLite commits, and returned as independent
copies. Missing/corrupt metadata disables automatic delivery; ordinary terminal input remains available.

Validation covers grouped limits, deletions/edits, overlapping reservations, lagged grant persistence, abrupt process
exit, schema migration/backup, malformed metadata, redaction expansion, busy/backoff and meeting reconciliation.
All data is disposable and model submissions use an inert PTY; no live model or production enrollment was used.
