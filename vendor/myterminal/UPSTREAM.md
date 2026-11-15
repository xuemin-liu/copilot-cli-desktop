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
| b75f5c9 | Shell resolver retained, including absolute-path passthrough; desktop uses absolute system paths |
| 0dd8c2b | Keep hidden terminal dimensions; skip zero-size fitting and refit after activation |
| 28fef6e | Restore focus to the terminal or its open search/filter overlay after switching |
| 3cb9372 | Restore focus after context-menu and dialog actions |
| 65cecc1 | Context-menu paste uses xterm's bracketed paste handling |
| fa885d7 | Literal question marks reach the shell without AI interception |
| faab1d6 | OSC52 decoding and protection from colorization across output chunks |
| 3de4e4a | Clipboard opt-in and size limit; validation of local spawn options |
| 70cbaa7 | Active-tab shortcuts; bounded reconnect for managed SSH |
| d5ba572 | Shared output-line buffering and chunk-safe working-directory detection |

The SSH manager's keepalive, jump-host, SFTP and double-close history was also inspected and
its implementation is now used for managed SSH connections. Native OpenSSH remains available
for existing config aliases. Its reconnect remains explicit; managed SSH reuses the bounded
countdown for live background connections as well as active tabs. This is a source integration into desktop tabs, not a second application window.

## Adapter boundary

- The renderer receives a per-tab `host` object instead of a global `electronAPI`.
  The desktop owns tabs, process lifetime, active-session routing and bounded output replay.
  The imported component owns terminal input, paste, focus, selection, search, filtering,
  colorization, font zoom and reconnect countdown behavior.
- The local manager accepts trusted main-process launch/cwd/environment/spawn hooks. Renderer
  spawn options still pass through the unchanged upstream validator. It also accepts an explicit
  termination signal and forwards exit metadata to the desktop adapter.
  Windows PowerShell, WSL and OpenSSH launches keep their absolute system paths, so an executable
  earlier on PATH cannot replace them. The original resolver remains available in the source.
- The desktop keeps its process watchdog, cancellation, project isolation and CLI helper injection.
  These hooks are not exposed as arbitrary renderer-selected executables or IPC channels.
- Styles are scoped to `.myterminal-embedded`; the original global application layout cannot
  restyle this app. Inactive terminal panes retain their width, following upstream's layout fix.
- The adapter patch forwards xterm grid-resize events to the PTY and disposes that subscription.
  Review reproduced an upstream font-zoom gap: changing the font resized the grid without
  changing the parent box, so ResizeObserver alone left the shell at its old dimensions.
- MyTerminal's SSH/tunnel managers, SFTP/editor, split pane, snippet, settings and connection dialogs,
  backup/logging registrars and Zustand actions are reused. `electron/main.js` is adapted into a
  project-owned registrar with injected dependencies; its standalone app/window and AI lifecycle are removed.
  `services.cjs` limits operations and channel ownership, verifies host fingerprints and connects process
  output to the upstream logging handler. No second CLI session picker or AI provider is exposed.
- `project-store.mjs` creates one upstream store per desktop project. The desktop remains the authority
  for terminal tab and split-channel lifetimes. Native and managed SSH both use the same CLI read/write bridge.
- The original `TabBar.jsx` and `Sidebar.jsx` supply tab dragging, naming, colors, connection search,
  grouping, copy and export controls. Host adapters connect their actions to desktop tab IDs and project stores.
  The original WSL discovery handler is exposed with an absolute Windows executable path and hidden process.
  Broadcast routing reuses `terminalChannels.js`; the main process restricts targets to connected terminal tabs
  in the shown project and resets broadcast on hide/project switch. Temporary SSH configurations use the existing
  encryption and connection resolver in memory; only explicit Save connection writes them to the project store.
- Downstream fixes add pending-SSH cancellation, transport cleanup, late-SFTP cleanup, live settings,
  background logs, scoped tunnel IDs, fragmented SOCKS framing and remote forwarding destination checks.
  Saved credentials fail closed when OS encryption is unavailable. The supplied desktop action remains
  current-session **Add to prompt**. OSC52 stays disabled by default.

The bell handler and bounded reconnect countdown originally in `TerminalTab.jsx` are extracted into
`lifecycle.cjs`, shared by that component and the desktop main process. The extraction retains the
five-second per-terminal bell cooldown, focus gating, five attempts, increasing five-second retry delay,
and reset on successful connection. Live process ownership now drives these handlers; a hidden view or
project switch does not stop them. Explicit cancellation, tab/project removal and shutdown do stop retries.
The renderer suppresses its duplicate bell/retry handlers when the main process owns the lifecycle.

## Updating the snapshot

This snapshot does not automatically track changes in the separate MyTerminal repository.
On a clean working branch, run `python scripts/import-myterminal.py PATH_TO_MYTERMINAL`.
The importer reads committed files and applies `desktop.patch`; conflicts must be resolved
explicitly. Inspect the intervening history, refresh the patch and verify original hashes.
Run `npm run myterminal:check`, the native terminal bridge check, the component regression
check, and the full-app tab-switching check. Keep new integration logic in adapters.
After changing imported files, run `python scripts/update-myterminal-patch.py PATH_TO_MYTERMINAL`
to record their exact differences against the pinned revision, then verify the snapshot again.

No standalone upstream license file was present at this revision. The user's own source is
retained with its repository, authorship and exact revision identified here.
