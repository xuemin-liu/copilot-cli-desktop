# Attention and linked-resource observations

Needs you retains actionable tasks after their tab closes and routes their Open action through the existing History
validation. It does not start a dormant session to populate the list. Missing history leaves the task and a visible
recovery message. Failures, unavailable resources and unresolved handoffs precede questions and review results.
Unreported rule-created investigations ask for review without claiming a successful outcome.

Task details show whether the session is open and the last worktree observation: present, missing, unknown, or not
recorded, with its check time. Only active task paths are checked, through asynchronous read-only directory metadata.
Results are cached for a minute; resource changes are rechecked on subsequent state reads. At most four real reads
remain in flight. A timeout is Unknown and retains its underlying concurrency slot. Old-path results cannot overwrite
a newer path, and no observation creates a folder, checkout, session or worker. A missing recorded worktree creates
attention while preserving the last reported task outcome.

On startup, restored attention is a silent baseline. New background actionable evidence is coalesced for 250 ms and
honors notification preferences. Notification bodies contain only a bounded redacted title plus app-defined reasons,
or an app-defined count for a burst. Requests, questions, summaries, validation details, URLs and CI/review bodies are
excluded. Source facts remain stable when a tab closes or a temporary approval clears; those presentation changes do
not notify an old task result again. A new report or a cleared-and-returning reason is new evidence.

Validation includes filesystem deletion and deferred-read barriers, coalescing/restart/foreground fixtures, the actual
Notification-constructor payload from the production report path, and an isolated Electron History-navigation/error
check. It uses disposable data and an inert PTY; no paid model or production workflow is involved.

Each broadcast computes one shared task/meeting/delivery snapshot for notifications and all windows. Validated task records are cached and invalidated after local writes or an external SQLite data-version change; returned copies cannot mutate the cache.
