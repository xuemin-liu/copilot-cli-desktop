# Export and import migration plan

Status: core Windows settings migration implemented. See [migration.md](migration.md)
for the shipped behavior and validation commands. History export/restore remains
gated; no CLI version pair is advertised as supported for history migration.
External custom instruction/skill directories are reported for separate transfer.
The design below retains the later history milestone for follow-up work.

## Outcome

Add **Settings → Migration → Export / Import** so a user can move Copilot CLI
customizations and Desktop preferences between Windows computers in one archive.
Import previews every change, maps workspace paths, keeps existing destination
data by default, and reports anything that needs installation or reconnection.

Version 1 supports Windows to Windows only. The manifest records the source OS
and CLI version so later cross-platform support does not need a new archive
format. Copying files does not transfer account-level state, and conversation
compatibility across CLI versions is not guaranteed; the UI must say both.

## Source roots

- **CLI root:** `COPILOT_HOME`, falling back to `~/.copilot`. This matches the
  resolution already used in `main.ts`, `session-fork.ts`, and the usage service.
- **Agent skills root:** `~/.agents/skills`. `COPILOT_HOME` does not move it.
- **Desktop storage:** Electron's `app.getPath('userData')`, which holds
  `desktop.json`, `protected-credentials.json`, `usage.sqlite`, `usage-backups/`,
  and `logs/`.
- **Background CLI controller:** `%APPDATA%\copilot-cli-desktop\cli` (or
  `COPILOT_DESKTOP_CLI_HOME`). Never exported; relevant only because it can own
  running `copilot` processes.

## What the archive includes

| Category | Sources (relative to the CLI root unless noted) | Default and import behavior |
| --- | --- | --- |
| CLI preferences | `settings.json` | Selected. Parse JSONC; merge by key with a preview. |
| Personal knowledge | `copilot-instructions.md`, `instructions/` | Selected. Preserve files and relative structure. |
| Personal skills and agents | `skills/`, `agents/`, and `~/.agents/skills/` | Selected. Copy each complete skill directory including scripts and reference assets. Keep the two skill roots distinct in the archive. |
| Tools and automation | `mcp-config.json`, `lsp-config.json`, `hooks/`, `extensions/` | Optional, unselected by default. Show commands and missing dependencies. Require explicit selection before any executable customization is written. |
| Desktop preferences and profiles | A validated, portable projection of `desktop.json` (see below) | Selected. Map workspace paths and regenerate path-derived profile IDs. |
| Project knowledge | For each selected repository: `.github/copilot-instructions.md`, `.github/instructions/`, `.github/skills/`, `.github/agents/`, `.github/hooks/`, `.github/copilot/settings.json`, plus `AGENTS.md`, `.agents/skills/`, and `.claude/skills/` where present | Optional. Preserve repository-relative paths and inventory nested instruction files explicitly. Recommend Git for tracked files; allow local-only customizations. Never copy a whole repository implicitly. |
| Plugins | Inventory of installed plugin identifiers, sources, and versions | Selected as an inventory only. Reinstall through the existing resource helpers after the user selects each plugin. Missing or local sources become follow-up items. |
| Conversation history | Recognized `session-state/<uuid>/` directories and a consistent snapshot of `session-store.db` | Optional. Import only for verified CLI formats into an empty destination (see the compatibility gate). |
| Token usage | Portable export from the existing `UsageService` | Optional. Restore through its existing merge behavior. |

### Desktop projection

Export only these `desktop.json` fields:

- Preferences: `closeBehavior`, `trayEnabled`, `notifications`,
  `automaticUpdateChecks`, `globalShortcutEnabled`.
- Provider: `type`, `model`, `offline`. Never `baseUrl`, which is treated as a
  credential and lives in the vault.
- Profiles: `name`, `path`, `permissionPreset`, `defaultResumeMode`, `launch`,
  and `tabs`. Profile `id` is derived from the lowercased resolved path, so the
  importer recomputes it after path mapping instead of copying it.

Never export `launchAtLogin`, `lastRunVersion`, or `rollbackVersion`. On import,
run the projection through the existing `readDesktopConfig` normalization so
profile and tab limits, preset validation, and launch-config normalization apply
exactly as they do for a hand-edited file.

### Exclusions

Never include: `config.json` (authentication and plugin state),
`permissions-config.json` (approvals bound to local paths), `mcp-oauth-config/`,
`mcp-secrets/`, `installed-plugins/`, `plugin-data/`, `command-history-state/`,
`ide/`, `logs/`, Desktop's `protected-credentials.json` and `logs/`, process IDs,
control tokens, caches, update binaries, and OS integration state. Portable
plugin data needs a separately defined adapter. Surface permission-related
settings and launch presets separately in the preview so the user chooses which
to apply.

For older CLIs that still keep preferences in `config.json`, extract only
documented preference fields; never export the whole application-state file.
Unknown settings and unknown files are reported, not silently activated.
Inventory additional configured instruction and skill paths when discoverable;
include them only after explicit selection and report unresolved references.

### Secrets

Strip recognized credential fields from structured settings and MCP definitions,
preserve environment-variable references, and record required credential names
without values. The five vault credential names in `secure-credentials.ts` are
the minimum recognized set. Detection cannot prove that arbitrary Markdown,
hooks, or scripts contain no secrets, so let the user inspect the selected file
list and describe the archive as possibly containing private source material and
conversations. Version 1 writes an ordinary ZIP; password protection is later.

## Export flow

1. Discover available categories and show file counts, estimated size, source
   roots, missing references, and compatibility limitations.
2. Let the user select categories and repositories. History and executable
   customizations start unselected. Display excluded items and reconnection
   tasks.
3. Choose an output filename with the native save dialog, for example
   `copilot-migration-2026-09-11.zip`, matching the existing usage-export naming.
4. Export without stopping sessions or the background controller. Wait for queued
   Desktop settings saves, then capture each selected saved file into memory once.
   Keep each file's read-consistency check, but do not rescan the whole source or
   reject an export because a captured file changes afterward. Recheck member names
   at each skill/agent group's capture boundary and omit the whole group with a
   warning if membership changed while it was collected. Use private staging
   for the usage database snapshot and other temporary output.
   For history, require CLI writers to be stopped and take a consistent SQLite
   backup of `session-store.db`; never copy an active database without its
   committed WAL contents. Reuse the `session-fork.ts` snapshot approach, which
   already excludes `inuse.*.lock` and `.workspace-fork.lock` and refuses
   symlink-containing sessions. Closing the Desktop window is not enough: tray
   sessions and the background CLI controller can keep `copilot` running.
5. Write the archive to a temporary output, verify entries and hashes by reading
   it back, then rename it to the chosen destination. Cancellation removes only
   run-owned staging and output files.
6. Show counts, exclusions, and **Show exported file**.

## Archive contract

Use a streaming ZIP library that works inside the packaged Electron app. Pin
its version and confirm packaging with `pnpm pack:win`, which runs the package
audit and package smoke. Keep compression and hashing off the UI thread, in the
main process or a worker like `usage-worker.ts`.

```text
manifest.json
copilot/...                      # CLI-root files by category
agents-home/skills/...           # ~/.agents/skills
desktop/preferences.json         # Desktop projection
projects/<archive-project-id>/...
plugins/inventory.json
history/...
usage/usage.sqlite
reports/export.json
```

The versioned manifest records export time, app and CLI versions, source OS,
selected categories, logical source roots, project mappings, and each file's
category, relative archive path, size, and SHA-256. It also records history
format information and credential or dependency requirements without values.
Source paths are descriptive metadata, never trusted destination paths. Hashes
detect corruption; they do not establish who produced the archive.

## Import flow

1. Select the archive in a native open dialog. Validate the manifest, format
   version, size limits, entry paths, and checksums before touching any file.
2. Stage validated contents. Reject absolute paths, traversal, links and
   junctions, Windows device names, alternate data streams, duplicate or
   case-colliding paths, and excessive entry counts or decompressed sizes.
   Verify destination ancestors cannot redirect writes outside the chosen roots.
3. Show **Add / Change / Identical / Conflict / Unsupported** per category.
   Offer **Keep existing** (default) or **Use imported** for conflicts. Merge
   JSON settings by key; treat each instruction file as a unit; treat a skill or
   agent directory as one conflict unit so incompatible versions are never
   combined. Never remove unrelated destination files.
4. Map source workspaces to destination folders, for example
   `D:\githutb\project` → `C:\src\project`. Unmapped folders stay unresolved and
   cannot launch. Rewrite only known structured path fields. Report absolute
   paths inside free-form instructions and scripts without rewriting their text.
   Write project-local files only into explicitly chosen repository roots.
5. Show the final change list and follow-up tasks. **Import selected** applies
   this reviewed plan. Bind the plan to staged hashes and destination
   fingerprints; if either changes, invalidate the preview and require a new one.
6. Before mutation, block new app sessions, pause affected background writers,
   and verify the necessary processes are stopped. Explain external `copilot`
   processes the app cannot stop or verify. Back up every changed destination
   file, journal newly created files, and write each file atomically with
   `writeFileAtomic`. After an interruption, resume from the journal or restore
   the backups.
7. Reload Desktop and CLI settings and show imported, skipped, and failed
   counts. Imported tabs stay inactive and bind only to imported compatible
   sessions. Never enable launch at login, register shortcuts, or start sessions
   during import.
8. Offer separate actions to reinstall selected plugins, reconnect GitHub, MCP,
   and API credentials, and verify tools. Report these independently from the
   completed file import so a network failure cannot disguise restored files.

Usage merge runs after the reversible file transaction as a separate reported
step through `UsageService.restoreFrom`. Keep a pre-import usage backup, and do
not promise that file rollback also reverses merged usage. Keep recovery
backups until verification succeeds and show their location.

## Conversation-history compatibility gate

History is a separate milestone because the CLI owns its schema and workspace
references. The Desktop already reads two pieces of it: `session-history.ts`
validates `events.jsonl` with size limits (128 MiB per history, 8 MiB per
record), and the usage ledger reads `assistant_usage_events` from
`session-store.db` read-only. Build the adapter on those modules and on
fixtures from independently verified CLI versions. Version 1.0.82 is the fork
feature's minimum, not a migration compatibility guarantee. Confirm how
`session-state/`, `session-store.db`, attachments, and any
other required stores relate before enabling a version pair. Unknown files and
databases are listed as unsupported; a raw home-directory copy is never the
fallback.

Initially restore only into a destination with no existing CLI history, after a
schema and version check and path mapping. Refuse history restore into a
populated destination while still importing other categories. Never replace or
merge destination session databases blindly, rename session UUIDs, or rewrite
opaque records. Export stays available for supported snapshots even when the
current destination cannot restore them; explain the limitation before applying
anything. History merge needs a later adapter with explicit session-ID conflict
rules and database consistency tests.

## Implementation sequence

Follow the repository's flat layout: modules in `src/main/`, colocated
`*.test.ts` files run by `pnpm test`, and opt-in checks under `scripts/`.

1. **Inventory and contract:** add `migration-types.ts` and `migration-inventory.ts`.
   Implement root resolution, category discovery, the Desktop projection,
   credential exclusions, and test fixtures.
2. **Archive service:** add `migration-archive.ts` with manifest validation,
   streaming export and readback, staging cleanup, resource limits, and
   cancellation. Keep all filesystem access in the main process or a worker.
3. **Import planner and transaction:** add `migration-import.ts` with preview,
   path mapping, conflicts, destination-change detection, backups, operation
   journaling, and recovery. Reuse `readDesktopConfig` normalization and
   `atomic-file.ts`.
4. **Settings integration:** add `src/renderer/components/MigrationSettings.tsx`
   next to `UsageSettings.tsx` and mount it from `SettingsApp.tsx`. Add typed
   methods and events to `CopilotDesktopSettingsBridge` in
   `src/renderer/global.d.ts` and `src/preload/settings-preload.cjs`. Register
   `desktop-settings:migration-*` handlers in `main.ts` guarded by
   `assertTrustedSettingsSender`. Destinations and operation IDs stay under
   main-process control; progress and cancellation events carry no secret content.
5. **Dependencies and optional data:** connect `copilot-resources.ts` install
   helpers and `UsageService.exportTo` / `restoreFrom`; add project
   customization selection. Implement and verify the history adapter before
   enabling history restore. Core settings migration can ship with history
   visibly unavailable.
6. **Verification and documentation:** add `scripts/migration-smoke.ts` following
   `fork-smoke.ts`, document supported categories, version pairs, and recovery,
   and link the feature from README and `FEATURE_PARITY.md` once implemented.
   The background CLI can reuse the service later; it is not needed for version 1.

## Acceptance checks

- Export from fixture home A and import into home B with a different Windows
  user and repository paths. Settings, full skill assets, agents, and
  instructions survive; a custom `COPILOT_HOME` and `~/.agents/skills` both work.
- Existing destination files survive by default. Selected replacement,
  key-level merges, whole-skill conflicts, invalid JSONC, and unsupported
  versions behave as the preview showed. Reimporting identical content is
  idempotent.
- Credential fixtures never appear in structured export fields, the manifest,
  renderer messages, or logs. The DPAPI vault is never copied or decrypted.
- Corrupt archives, traversal, junctions, collisions, and decompression-limit
  violations fail before any destination write. Destination changes after the
  preview invalidate the pending import.
- Disk-full, locked files, cancellation, and crashes at transaction boundaries
  preserve originals or leave a recoverable journal. Restarts never silently
  launch imported sessions, hooks, or plugin installation commands.
- Usage restore keeps existing records without duplication. A compatible
  history restore resumes a fixture session after path mapping and restart;
  unsupported or populated destinations refuse history without losing data.
- Run `pnpm typecheck`, `pnpm test`, the migration smoke script, and a packaged
  Windows check of export, import preview, progress, conflicts, and recovery.
  Use disposable roots and no live user credentials.

## References

- [GitHub Copilot CLI configuration directory](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)
- [GitHub Copilot CLI skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills)
- Existing implementation: `src/main/desktop-config.ts`,
  `src/main/secure-credentials.ts`, `src/main/usage-service.ts`,
  `src/main/usage-ledger.ts`, `src/main/copilot-resources.ts`,
  `src/main/session-fork.ts`, `src/main/session-history.ts`,
  `src/main/atomic-file.ts`.
- Existing usage backup contract: [usage-ledger.md](usage-ledger.md).
