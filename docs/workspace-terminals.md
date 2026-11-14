# Workspace terminals

Use **New tab** in the session toolbar or **+** in the right panel to choose Browser, Git, Local terminal,
WSL terminal (Windows), or SSH. Terminal tabs use MyTerminal's search, filtering, colorization,
font zoom, context-menu paste, and focus handling, plus **Add to prompt** for the
selection or recent output. No destination session needs to be selected.

Local terminals open PowerShell on Windows or the configured shell on macOS/Linux in the project folder.
WSL opens the default distribution or the distribution you enter. SSH asks for a host/config alias and optional
user, port, and identity file. OpenSSH handles keys, host verification, passwords, and existing SSH configuration.
No SSH passwords are saved by the app. WSL and OpenSSH must be installed to use those terminal types.

Tabs belong to the project. Switching tabs/projects or hiding the panel preserves their processes. Closing a tab
terminates its PTY; quitting stops all terminals. Saved tabs return disconnected after restart—**Connect** starts
a fresh shell. **Reconnect** after an exit starts a new process, not a resumed shell. Up to 32 terminal runtimes
can exist at once. This integration brings terminal access into the existing panel; MyTerminal's SFTP, tunnel,
split-pane, and saved-connection interfaces are not included.

The implementation reuses MyTerminal's `TerminalTab.jsx`, terminal utilities, and local process manager
from revision `3de4e4a`. The imported source, original tests, history notes and small adapter patch are
tracked in [vendor/myterminal](../vendor/myterminal/UPSTREAM.md). SSH continues to use native OpenSSH.

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

Other actions: `list`, `read` (optional `cursor` and `generation`), `interrupt`, `close`, `start`, `restart`.
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
