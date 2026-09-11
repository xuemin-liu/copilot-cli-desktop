# Moving your Copilot setup to another computer

Open **Desktop Settings → Migration** on the source Windows computer. Select
the categories to transfer, click **Review export files**, inspect the file list,
and choose **Export ZIP**. Transfer that archive to the destination computer.

On the destination, install Copilot CLI Desktop and Copilot CLI, open
**Settings → Migration**, and choose the archive. Select categories and map each
workspace you want to keep to its folder on this computer. Click **Review import
changes**, choose any replacements, review again, then click **Import selected**.
Existing destination files are kept by default. Identical imports are skipped.

Close all Desktop and external Copilot sessions before export/import. Closing a
tray window does not stop its sessions. Stop the background controller with
`copilot-desktop stop`. The app checks for local writers and blocks new sessions
during migration. Avoid starting an external CLI until the operation finishes.

## Included data

- Supported CLI settings, personal instructions, full skill directories and
  custom agents. The CLI root follows `COPILOT_HOME`; `~/.agents/skills` remains
  a separate source.
- Portable Desktop preferences and workspace profiles. Choose destination
  folders to import profiles; unmapped profiles are skipped. Imported profiles
  start without restored session tabs. Existing login-startup and shortcut
  settings are retained.
- Optional tools, hooks, and extensions. Select **Tools** on both export and
  import to include executable settings, including inline hooks and status-line
  commands. Review commands and install their dependencies before starting a
  session. Skill scripts and agent definitions also require trusted sources.
- Optional project instructions and skills from explicitly selected saved
  workspaces, including nested `AGENTS.md` files. Git-tracked copies can also
  travel with a normal repository clone. Dependency/build folders are not scanned.
- Plugin inventory with individual installation actions after import. Plugin
  binaries, opaque plugin state, and authentication are not copied. Unsupported
  inventory formats or missing sources are reported for manual reinstallation.
- Optional usage records, merged through the existing usage backup service after
  file import. Repeat imports do not duplicate existing usage samples.

Configuration is parsed as JSONC. Imported settings merge by top-level key;
comments in modified configuration files are not preserved. Unknown settings
are omitted and reported. Known structured paths inside mapped workspaces are
updated; free-form scripts/instructions are not rewritten. Extra configured
instruction/skill directories are reported for separate transfer.

## Exclusions and compatibility

Version 1 supports Windows to Windows. **Conversation history export and restore
are unavailable** until an adapter is verified against the CLI's history schemas.
The existing fork minimum version does not establish migration compatibility.
Account-level knowledge is not transferred.

Credentials, OAuth stores, cached plugins, saved directory approvals, logs,
process state, and update caches are excluded. Reconnect GitHub, MCP services,
and provider credentials on the destination. Recognized structured secret fields,
literal environment/header values, and URL credentials/query parameters are
removed. `${NAME}` and `${env:NAME}` references are preserved. Arbitrary Markdown
or scripts and skill assets can still contain secrets. CLI settings use an
allowlist. Parseable JSON/JSONC in MCP/LSP, hooks, and extensions receives secret
filtering and structured path remapping without the settings allowlist; arrays
and scalars are supported. Parseable tool files are always serialized after
filtering so comments and shadowed duplicate keys cannot retain secrets.
Unparseable tool assets are preserved byte for byte
with an explicit review warning. The ZIP is not encrypted and should be private.

Links and junctions are unsupported. Limits are 64 MiB per file, 256 MiB total
uncompressed archive data, and 10,000 files. Directory traversal is also bounded.
Large data sets and unsupported files produce errors or explicit omission notes.
An unavailable skill or agent is omitted as a complete group while readable
sibling groups remain included. Missing optional paths are silent; an unavailable
selected workspace or a file disappearing during a group scan produces a warning.
Restore read access before exporting omitted items.

## Conflicts and recovery

Instruction files conflict individually. A skill or agent asset directory is one
unit: choosing its imported version replaces the directory's files and backs up
stale assets before removing them. Other directories remain untouched.

Import fingerprints the destination during preview and checks it again before
writing. Changes invalidate the preview. A journal and original-file backups are
saved under `migration-backups/<operation-id>/` in Desktop's data directory, with
the location shown after import. Failed or cancelled file transactions roll back;
startup recovers unfinished transactions before loading settings. Backups remain
available after success. If files were modified externally after a crash, recovery
stops and reports the backup location instead of overwriting those modifications.
Recovery errors do not prevent startup. Settings → Migration lists unresolved
journals and provides Retry recovery after you inspect and repair the affected
files. Journals marked as needing attention are not retried automatically.
To retain the current destination instead, inspect the backup directory, check
the acknowledgement box, and choose **Keep current files and dismiss this recovery**.
The journal is renamed to `journal.dismissed-<id>.json`; destination files and
backups are preserved, and further imports are allowed once all issues are resolved.
Dismissal only renames the inspected journal and does not require stopping sessions
or run recovery against other files. **Retained migration backups** lists completed,
rolled-back, dismissed, and abandoned preparation backups. They can contain
unencrypted credentials. Use **Delete backup…**, then **Permanently delete this backup**
when that recovery copy is no longer needed. Current settings remain unchanged;
unresolved recovery journals and active migration writes cannot be deleted this way.
Known atomic-write and SQLite temporary files are included in cleanup. An empty
folder left by an interrupted cleanup stays listed so deletion can be retried.
Pre-merge usage snapshots have their own label, separate from incomplete backup
preparation: deleting one removes that copy of the previous usage records.
The backup list is loaded when Settings requests it, and can be refreshed while
an export or import runs. Sizes and deletion tokens refresh after usage snapshots finish.
Refreshing also updates inspection warnings. Older status replies cannot replace
a newer list, and snapshot bookkeeping does not delay the usage merge. Failed
snapshots are not labeled as recovery backups. Their newly created folders are
removed only when empty; partial files and existing recovery backups are preserved.
If cancellation leaves a snapshot
running, the result reports its possible location and asks you to check that it
finished before relying on the copy. Status polling uses the loaded cache and
keeps only one automatic request in flight; failed initial scans can be retried.
The acknowledgement box applies to the complete displayed journal set and resets
when a journal is added, removed, or changed, even if two journals have identical contents.

Dismissal does not run recovery against other journals. A pending journal can
remain visible until Retry recovery or the next import attempts its rollback;
it is not permanently blocked by dismissal. A Desktop refresh warning remains
until an actual refresh succeeds, because listing or dismissing backups does
not refresh Desktop's in-memory settings.
Closing Settings cancels its migration operation; reopening Settings shows any
operation still finishing and retains access to Cancel. The last import outcome,
including cancellation, rollback, and skipped usage, remains visible when Settings
is reopened during the same app run. A usage merge already
committing must finish before cancellation takes effect.
Rejected preconditions do not replace the last import result. If an import commits
but Desktop cannot refresh its state, the result remains completed with a warning
to restart before changing settings. Busy state is reconciled periodically while
an operation is displayed, so a missed completion event cannot strand the panel.

Usage merge is a separate step with its own pre-import backup. A usage failure
does not undo a successful file import; the completion report explains how to
retry using the archive's `usage/usage.sqlite` file. Plugin installation is also
separate and occurs only when its individual install button is clicked.

## Verification

`pnpm test` covers archive validation, exclusions, conflicts, path mapping,
concurrent changes, cancellation and recovery. `pnpm migration:smoke` exercises
two isolated homes and the real usage worker. `pnpm migration:check` exercises
the production Settings renderer, preload and IPC with disposable files and
scripted native file dialogs and the real controller check; it saves screenshots and a result under
`test-results/migration/`. It starts no model sessions or stops user processes.
`pnpm pack:win` verifies the packaged runtime.

The controller check authenticates this installation's background controller;
if the probe fails but its saved PID is still alive, migration waits for the
controller to stop or respond. It does not scan machine-wide process names.
The error identifies the saved state file when a PID may have been reused. After
verifying that the controller and its Copilot child have stopped, move that stale
file aside and retry; do not terminate an unrelated process based on its PID alone.
Close external CLI sessions yourself.
Export snapshot checks and import destination fingerprints detect concurrent file
changes. Reviewing inventory or an import preview does not block terminal input.
Both migration smoke and Settings integration checks run in Windows CI.
