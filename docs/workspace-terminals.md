# Workspace terminals

Use **New tab** in the session toolbar or **+** in the right panel to choose Browser, Git, Local terminal,
WSL terminal (Windows), or SSH. Terminal tabs use MyTerminal's search, filtering, colorization,
font zoom, context-menu paste, and focus handling, plus **Add to prompt** for the
selection or recent output. No destination session needs to be selected.

Local terminals open PowerShell on Windows or the configured shell on macOS/Linux in the project folder.
WSL opens the default distribution or the distribution you enter. **SSH** offers saved MyTerminal connections
with password/private-key authentication and optional jump hosts. Credentials use the OS credential store;
the renderer receives presence flags, not saved passwords. New or changed host fingerprints require verification.
The **OpenSSH (native)** form remains available for existing config aliases and native authentication prompts.
WSL and native OpenSSH must be installed to use those options.

WSL offers the installed distributions as suggestions, with manual entry still available. Saved SSH connections
reuse MyTerminal's searchable, collapsible groups and right-click Edit, Save a copy and Delete actions.
The connection toolbar exports connections without credentials; Settings & backup provides the full backup.
In the SSH dialog, **Connect** opens a temporary connection without saving it. Its credentials stay in memory
for reconnect and split panes, and are discarded when the tab closes or the app quits. Right-click its tab and
choose **Save connection** to retain it. Temporary tabs are not restored after restart.

Drag side-panel tabs to reorder them. Right-click a tab to rename it or choose a color; these choices persist
with saved tabs. The broadcast button sends terminal typing/paste to all connected parent terminal tabs in
the current project, using MyTerminal's broadcast routing. Browser/Git tabs, disconnected terminals and split
panes are excluded. **Broadcast ON** stays visible while enabled; hiding the panel, switching projects or
restarting the app turns it off. CLI writes addressed to a terminal ID remain individual writes.

Tabs belong to the project. Switching tabs/projects or hiding the panel preserves their processes. Closing a tab
terminates its PTY; quitting stops all terminals. Saved tabs return disconnected after restart—**Connect** starts
a fresh shell. **Reconnect** after an exit starts a new process, not a resumed shell. Up to 32 terminal runtimes
can exist at once, including split panes. Managed SSH uses MyTerminal's bounded reconnect countdown even while
its tab/panel is hidden or another project is active. The five-attempt policy resets after a successful connection;
Cancel or closing the tab stops a pending retry. Native shells reconnect explicitly. Terminal bells use MyTerminal's five-second notification cooldown while the app is unfocused, including hidden tabs and other projects. Split panes close with their parent and are not restored on restart.

The terminal toolbar includes **Snippets**, **Split pane**, **Start/stop logging**, **Export terminal output**,
and **Settings & backup**. Settings and snippets are project-scoped. Logging runs in the main process, including
while the panel is hidden, and stops when the process exits. The default log folder is inside that project's
MyTerminal data folder. Settings can change the folder, font, scrollback, highlighting and OSC52 clipboard opt-in.
Backup/import reuses MyTerminal's format and merge behavior; exports exclude credentials unless explicitly chosen.
Removing a workspace deletes its saved terminal connections/preferences and default logs after closing their streams.
Logs written to a custom folder outside the app's project data directory are kept.

Managed SSH tabs also include **SFTP** with uploads/downloads, favorites and remote text editing, and
**Port forwarding** for local, remote and SOCKS5 tunnels. Forwarding listeners bind to loopback. Closing the
terminal stops its transfers and tunnels. These controls are unavailable on native OpenSSH tabs.

The implementation reuses MyTerminal's `TerminalTab.jsx`, terminal utilities, and local process manager
from revision `3de4e4a`, plus its SSH/tunnel managers, service handlers, dialogs and project-specific store instances.
The imported source, original tests, history notes and explicit adapter patch are
tracked in [vendor/myterminal](../vendor/myterminal/UPSTREAM.md).

## CLI and shell access

New/resumed Copilot sessions receive terminal instructions and `COPILOT_DESKTOP_TERMINAL_HELPER`.
The helper works without any Browser tab. On Windows:

```powershell
& $env:COPILOT_DESKTOP_TERMINAL_HELPER list
& $env:COPILOT_DESKTOP_TERMINAL_HELPER read TERMINAL_ID
& $env:COPILOT_DESKTOP_TERMINAL_HELPER request C:\path\request.json
```

On macOS/Linux, or inside an app-created WSL terminal:

```sh
sh "$COPILOT_DESKTOP_TERMINAL_HELPER" list
sh "$COPILOT_DESKTOP_TERMINAL_HELPER" read TERMINAL_ID
sh "$COPILOT_DESKTOP_TERMINAL_HELPER" request /path/request.json
```

WSL uses a small wrapper around Windows PowerShell to reach the Windows listener under both NAT and mirrored
networking. Local/WSL terminal shells receive the helper automatically. Remote SSH shells do not receive the
desktop's local helper/token; the CLI can still read and write their SSH terminal by ID from the desktop.
The same commands are available through `copilot-desktop terminal` when that executable is on PATH.

Example request files:

```json
{"action":"create","kind":"local"}
```

```json
{"action":"create","kind":"ssh","config":{"host":"my-server","username":"alice","port":22}}
```

```json
{"action":"write","id":"TERMINAL_ID","text":"pwd\r"}
```

Other actions: `list`, `read` (optional `cursor` and `generation`), `interrupt`, `close`, `start`, `restart`,
`split` and `unsplit` (parent terminal ID). `list` includes split channel IDs with their `parentId`.
Terminal IDs are explicit: selecting another visible tab never redirects input. CLI access follows the active
session and its project. Read-only, side-chat, and remote CLI sessions cannot use terminal control. Shell-helper
access requires its own project to be active. An input request already accepted before switching may continue
executing; switching does not kill background work.

Read responses contain raw terminal output, `cursor`, `start`, process `generation`, and shell status. Retained
output is bounded to 512 Ki characters. If `start` exceeds the requested cursor, older output was discarded.
Send the previous `generation` with incremental reads to reset the cursor after reconnecting. A successful
`write` confirms delivery only; newlines may execute commands, and individual command completion/exit codes
are not inferred. `exitCode` belongs to the shell process. Inspect output before claiming a command succeeded,
and read before retrying a write whose transport failed.
