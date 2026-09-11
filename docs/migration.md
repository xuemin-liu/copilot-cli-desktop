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
or scripts, and arbitrary JSON assets inside skills, hooks, and extensions can
still contain secrets. Only known CLI settings and MCP/LSP configuration files
receive structured filtering; assets are preserved byte for byte. The ZIP is not encrypted and should be
treated as private.

Links and junctions are unsupported. Limits are 64 MiB per file, 256 MiB total
uncompressed archive data, and 10,000 files. Directory traversal is also bounded.
Large data sets and unsupported files produce errors or explicit omission notes.

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
Closing Settings cancels its migration operation; reopening Settings shows any
operation still finishing and retains access to Cancel. A usage merge already
committing must finish before cancellation takes effect.

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
it does not scan machine-wide process names. Close external CLI sessions yourself.
Export snapshot checks and import destination fingerprints detect concurrent file
changes. Reviewing inventory or an import preview does not block terminal input.
Both migration smoke and Settings integration checks run in Windows CI.
