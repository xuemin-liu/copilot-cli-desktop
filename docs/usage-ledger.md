# Monthly token usage

Open **Settings → Monthly token usage** to select a month, reporting timezone,
and session scope. Input means uncached input; cache reads and writes are counted
separately. Reasoning is displayed separately because its overlap with output is
unverified. App scope includes whole sessions observed by the desktop, including
requests made elsewhere in those sessions.

The app collects surviving local request records at startup, every 30 seconds,
and on session exit. Shutdown snapshots fill gaps provisionally. Usage spanning
months without enough timing information is shown as unallocated. Missing history,
unknown fork ancestry, and unsupported CLI formats produce coverage warnings.
Collection cannot recover unobserved records already deleted by Copilot, remote
usage, or usage from other computers; these totals are not account-wide billing.

## Saved data and backups

Collected records live in `usage.sqlite` under Electron's existing user-data
directory, outside the installation, Copilot history, and pruned session logs.
SQLite transactions commit records together with import progress. A worker handles
collection so large imports do not block the desktop. No prompt contents or
credentials are stored in the ledger.

Verified backups under `usage-backups/` retain 30 daily and 12 monthly copies per
ledger generation. Locked old copies may temporarily exceed retention; cleanup
retries during later backup rotations. Failed backup refreshes remain visible
across restarts. Routine retries happen at most once per 10 minutes; update and
quit flushes can retry immediately. Portable copies exclude local retry state.

**Export backup** saves a portable copy to another folder. **Restore backup**
merges valid records without deleting newer saved usage. A committed restore remains
successful if its backup refresh fails; the backup warning stays visible for retry.
Keep an export outside the app-data directory to protect against loss of that entire
directory.

## Recovery

A missing ledger starts fresh in a new backup generation. Earlier generations
remain available without rotation, and a warning offers explicit restore when
earlier backups exist. Corruption recovers from a verified local backup while
preserving damaged originals. Future database versions are never silently reset.

An interrupted recovery resumes the verified, durable copy named in its journal,
including a user's explicitly selected backup. If that copy is damaged, parked
originals are restored first; ambiguous files or temporary access failures retain
the recovery evidence for retry. A completed journal never reinstalls parked
corrupt originals after a later ledger deletion. Temporary-file cleanup failures
do not conceal a successful restore.

## Updates and shutdown

The installer stops sessions and waits for collection to commit. Backup-only
failures produce a warning and get another attempt during quit. An already
unavailable usage worker is logged without blocking updates; live collection
failures still prevent installation. Failed or no-op installers resume collection.

Shutdown has a 30-second overall deadline. Already committed data survives a
forced worker stop, although records not collected before the deadline may be
missing. Repeated worker failures stop automatic replacement until the app
restarts. Portable exports remain the protection against losing the entire
app-data directory.

## Verification

Run `npm run usage:check` to build and exercise the production usage worker in
Electron, including backup creation and restart after source-history deletion.
The check uses temporary data and does not start a model or show a window.
