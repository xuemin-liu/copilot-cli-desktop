# MyTerminal source integration

Source: https://github.com/xuemin-liu/MyTerminal

Pinned revision: **3de4e4a2ac2e83100306020f92499368b9d90cb4** (2026-07-04).
The source checkout at `D:\GitHub\MyTerminal` was inspected without changing it.

This is a vendored source integration, not a new terminal implementation. The right panel
renders `src/components/TerminalTab.jsx` and its terminal utilities. The main process runs
`electron/local-terminal.js` with the desktop's native PTY/watchdog supplied as a dependency.
`upstream.json` records the SHA-256 of every original file, including all six original test
files (54 tests). `desktop.patch` describes every downstream edit to imported files.
`npm run myterminal:check` reverses that patch in a temporary directory and verifies the
original hashes before running the imported tests.

## Fixes inherited from the inspected history

| Upstream commit | Behavior used here |
| --- | --- |
| b75f5c9 | Windows shell discovery when System32 is absent from PATH, including PATHEXT |
| 0dd8c2b | Keep hidden terminal dimensions; skip zero-size fitting and refit after activation |
| 28fef6e | Restore focus to the terminal or its open search/filter overlay after switching |
| 3cb9372 | Restore focus after context-menu and dialog actions |
| 65cecc1 | Context-menu paste uses xterm's bracketed paste handling |
| fa885d7 | Literal question marks reach the shell without AI interception |
| faab1d6 | OSC52 decoding and protection from colorization across output chunks |
| 3de4e4a | Clipboard opt-in and size limit; validation of local spawn options |
| 70cbaa7 | Active-tab shortcuts; bounded reconnect remains available in standalone mode |
| d5ba572 | Shared output-line buffering and chunk-safe working-directory detection |

The SSH manager's keepalive, jump-host, SFTP and double-close history was also inspected.
That manager is **not** used: this app retains native OpenSSH for existing config aliases,
keys, passwords and host verification. Its PTY still uses the reused local-terminal manager
and MyTerminal renderer. Do not claim that the full MyTerminal application was merged.
Native OpenSSH reconnect remains explicit so a logout or authentication failure cannot
silently start another shell. The upstream SSH reconnect loop is retained for standalone use.

## Adapter boundary

- The renderer receives a per-tab `host` object instead of a global `electronAPI`.
  The desktop owns tabs, process lifetime, active-session routing and bounded output replay.
  The imported component owns terminal input, paste, focus, selection, search, filtering,
  colorization, font zoom and reconnect countdown behavior.
- The local manager accepts trusted main-process launch/cwd/environment/spawn hooks. Renderer
  spawn options still pass through the unchanged upstream validator. It also accepts an explicit
  termination signal and forwards exit metadata to the desktop adapter.
- The desktop keeps its process watchdog, cancellation, project isolation and CLI helper injection.
  These hooks are not exposed as arbitrary renderer-selected executables or IPC channels.
- Styles are scoped to `.myterminal-embedded`; the original global application layout cannot
  restyle this app. Inactive terminal panes retain their width, following upstream's layout fix.
- MyTerminal's independent session picker, AI-provider UI, SFTP, tunnels, split panes, snippets
  and disk logging are not exposed in this host. Their component dependencies remain in the
  source snapshot to keep upstream imports and defaults intact. The desktop supplies its
  current-session **Add to prompt** action. OSC52 remains disabled by default, as upstream requires.

## Updating the snapshot

This snapshot does not automatically track changes in the separate MyTerminal repository.
On a clean working branch, run `python scripts/import-myterminal.py PATH_TO_MYTERMINAL`.
The importer reads committed files and applies `desktop.patch`; conflicts must be resolved
explicitly. Inspect the intervening history, refresh the patch and verify original hashes.
Run `npm run myterminal:check`, the native terminal bridge check, the component regression
check, and the full-app tab-switching check. Keep new integration logic in adapters.

No standalone upstream license file was present at this revision. The user's own source is
retained with its repository, authorship and exact revision identified here.
