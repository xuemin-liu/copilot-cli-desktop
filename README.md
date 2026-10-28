# Copilot CLI Desktop

An Electron desktop shell and background CLI for the
[GitHub Copilot CLI](https://github.com/github/copilot-cli) (`copilot`), for Windows, macOS and Linux.
See [Platforms](#platforms) for what differs between them.

> **This is an unofficial, community-built wrapper around the public `copilot`
> CLI.** It is not affiliated with, endorsed by, or supported by GitHub or
> Microsoft. GitHub Copilot is a trademark of GitHub, Inc.

Unlike a CLI with a bundled local web server, `copilot` is a terminal/TUI
program. This app spawns it with [`node-pty`](https://github.com/microsoft/node-pty)
and renders each session's real terminal in the desktop window using
[`xterm.js`](https://xtermjs.org/), streamed over IPC from the sandboxed
renderer's preload bridge — the renderer never gets a raw child-process or pty
handle, only input/output/resize events.

## Features

- **Export and import your setup** from Settings → Migration: move CLI settings,
  instructions, skills, Desktop profiles, and optional project files and usage in
  one ZIP, with conflict previews, workspace mapping, and recovery backups.
  Windows-to-Windows; history migration is not yet supported. See
  [migration and recovery](docs/migration.md).
- **Monthly token usage** in Settings counts local request tokens and saves collected
  totals in the app-data directory, independently of session history and software updates.
  Updates and quit commit collected usage with a bounded wait; verified backups and
  export/restore help recover saved records. See [usage coverage and recovery](docs/usage-ledger.md).
- Resolves the `copilot` binary (PATH, legacy GitHub CLI-managed location,
  then a compatible `gh copilot --` installation), and shows a recovery dashboard with install/retry actions
  and a copyable diagnostic summary when it cannot be found.
- **Fan out** (⫶ in the sidebar): start the same task in two to five fresh sessions, each in
  its own Git worktree, one after another. The task is pasted into each prompt box and
  nothing is sent until you press Enter in each session; the sessions share a label in the
  sidebar, and the Git panel's worktree list lets you compare and keep one.
- A standard collapsible AI-tool sidebar with workspace/session search,
  grouped or flat session views, manual/last-activity ordering, named recent
  workspace profiles, manual session naming, attachment-aware session
  creation, and restored session tabs.
- The **Fork into side chat** button (branch icon in the session header) keeps a main conversation on the left and an independent,
  resizable conversation on the right. Side chats use read/search-only model tools,
  including after restart, and can be closed without stopping the main session.
- **Review meetings** let other sessions, in any project and with any model, review one session's plan or uncommitted
  changes. Say "start a meeting to review your plan" in one session and "join meeting <id>" in the others; the desktop
  passes the rounds between them until every reviewer agrees. An agent outside the desktop, such as Claude Code or Codex CLI,
  can review too: **Invite outside agent…** on the meeting bar. See [Review meetings](#review-meetings).
- **Debug browser** opens your web app beside the terminal, with native Chromium
  DevTools and Local Overrides. Console and network activity are also available
  through `copilot-desktop browser` commands, without an MCP server. Testing mode
  lets the assistant run user-described web-app workflows and check expected results,
  with step reports and screenshots.
- **Git panel** (Ctrl+Shift+G) shows the repositories in your project folder beside the
  session: branch, changed files, diffs and history, updated as Copilot works. It can
  add a diff, comments on its lines, or a request for a commit message, to the prompt box. It can stage and
  unstage files, make local commits (a repository's own hooks need your approval first),
  fetch, fast-forward pull and push (never forced, never prompting for credentials), and
  create or switch local branches (a switch is refused while a Copilot session is working
  and is confirmed first), and discard changes (a copy of each tracked file is saved first,
  untracked files go to the Recycle Bin, and you confirm in a native window), and amend the last commit
  (only while it is not on any remote branch). Repositories whose own settings can run programs wait for
  your review before anything is read. A session that runs in a Git worktree shows its branch as a chip,
  and the panel lists that worktree as a repository of its own and follows it. See [the Git panel](docs/git-panel.md).
- Session identity and resume: each fresh tab gets a desktop-generated UUID
  through `--session-id` and a Copilot-visible `--name`, then auto-resumes with
  `--resume <id>` (or `--continue`) when reopened, plus a
  manual "Resume session…" action that opens `copilot --resume`'s own
  interactive picker directly inside the terminal pane.
- Saved tabs start lazily: at launch only the tab on screen starts, and every other saved tab is listed as
  **Not started** and starts the first time it is shown. **Unload** (☾ in a session's actions, or File → Unload Active
  Session) stops a session to free its memory but keeps its tab; **Resume this session** picks the conversation up again.
- **Session history** (◷ in the sidebar, or Ctrl+Shift+H) lists the sessions Copilot has stored, newest first, by their
  first and latest prompt, project, branch and last use, with a search box. Opening one shows its tab when it is open, or
  resumes it in a new tab in its project (or that project's worktree), adding the project when it is not open yet.
- Per-session pty process supervision: crash detection, a restart action, and
  private per-session log capture under the app's user-data directory. Logs
  rotate at 5 MiB; launch directories are limited to 7 days and the latest 20.
- Native session tabs (Ctrl+T new, Ctrl+W close) bound to one pty session
  each. A new session can be named first; left empty, Copilot names it from
  the first prompt and the tab follows that name (until then it shows the
  project's name, greyed out in the dialog). **Start in** picks where that one
  session runs: the project folder, **A new Git worktree** (its own worktree
  and branch; the dialog previews the name, and the choice starts from the
  project setting), or one of the repository's existing linked worktrees,
  which restarts and restores keep using while it exists. Unticking
  **Use the shared Local Overrides and DevTools settings** gives that session's
  browser its own Local Overrides folder and switch (the default is in
  Settings → Session browser).
  Renaming a tab renames the Copilot session too, so `copilot --resume
  "<name>"` and Copilot's session list find it by that name after it
  closes; the rename is typed as `/rename` only while the session is idle
  with an empty prompt box (or as the tab closes). Tabs renamed before this
  release are left as they are; rename one again to send its name. Sessions
  have lifecycle badges (starting / running / needs-approval / stopping
  / completed / crashed) and are restored per workspace profile.
- **Paste screenshots with Ctrl+V** while Copilot's prompt is ready. Text uses
  xterm's normal paste handling; image-only paste invokes Copilot's native Alt+V
  attachment shortcut. Alt+V also reaches Copilot directly. A clipboard containing
  both text and an image pastes the text; use Alt+V to attach its image. Pasting
  adds to the draft without submitting it. Text pastes are limited to 1,000,000
  characters; image storage is handled by the CLI.
- A tray icon: closing the window hides it and keeps sessions running; the
  tray menu can reopen the window, start a new tab, open settings, or quit.
  Toggleable in Settings.
- Native OS notifications on approval-needed, session-completed, and
  session-crashed; clicking one focuses the window and the relevant tab.
- An update center backed by `electron-updater`, pointed at this repository's
  GitHub Releases.
- Optional launch-at-login and an optional global show/hide shortcut
  (Ctrl+Alt+H), both opt-in via Settings.
- Provider settings for GitHub Copilot, OpenAI, Azure OpenAI, and Anthropic,
  including base URL, model, and offline mode. A secure credential vault
  (Electron `safeStorage`: Windows DPAPI, the macOS Keychain, or a Linux keyring) protects
  `COPILOT_PROVIDER_API_KEY`, the legacy `COPILOT_PROVIDER_BASE_URL`, and the
  supported GitHub token overrides `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and
  `GITHUB_TOKEN`. If protected storage is unavailable, saving is refused
  instead of silently falling back to plaintext.
- Per-workspace Copilot launch profiles for model, reasoning effort, context
  tier, custom agent, interactive/plan/autopilot/plan-then-autopilot mode,
  AI-credit and continuation limits, worktrees, screen readers, remote control,
  and session-export privacy. The desktop creates a new worktree before launching
  Copilot in it. **Settings → General → Worktree timeout (minutes)** controls the
  checkout time limit (default: 10 minutes). A fresh worktree
  session lets the CLI choose its session id. The desktop names the worktree and its branch
  (`desktop-<session title>-<6 hex>`), finds the session that runs in that
  worktree in the session store within about a minute, then monitors and
  resumes it as usual.
  **Settings → General → When a worktree session closes** decides what happens to
  that worktree when its tab is closed: by default it is removed when nothing is
  lost (no uncommitted changes; its `desktop-*` branch is deleted too when every
  commit on it is also on another branch, and kept otherwise), and a worktree with
  changes is removed only after you confirm, to the Recycle Bin. **Ask every time**
  and **Keep the worktree** are the other choices. An existing worktree a session
  was started in, and one another open tab still uses, are never removed.
- A Copilot management center that can install, repair, and update the official
  CLI; exposes Copilot's native session-start automatic updates with stable and
  prerelease channels; labels sessions still running an older CLI after an
  update; detects supported integration capabilities; and manages plugins, remote
  MCP servers, and skills without requiring users to memorize commands.
- Remote-session connection from the sidebar using an existing Copilot session
  or task ID.
- Visible Windows elevation and permission-access status, with warnings for
  high-trust modes and elevated launches.
- Stops the full process tree for every running session on app quit, with a
  detached watchdog covering abrupt desktop-process termination (PowerShell on
  Windows, `sh` on macOS and Linux, where each child leads its own process group).
- A background CLI (`copilot-desktop`) with a token-protected, loopback-only
  HTTP control server (`start` / `status` / `restart` / `logs` / `stop`) and a
  first-class `run --prompt` command for official non-interactive Copilot
  execution, JSONL output, custom agents, models, and transcript export.
- Packaging via `electron-builder` (Windows NSIS installer, macOS dmg and zip,
  Linux AppImage and deb), post-package runtime auditing, and signed
  tag-triggered Windows releases with unsigned publication blocked.

## Session windows

For the browser pane, native Local Overrides, authenticated ticket reading and CLI console/network commands,
see [web app debugging](docs/browser-debug.md).

Click **Open in new window** (↗) above a terminal or in a session's **⋯** actions
to move it to a separate, resizable window. You can open several session windows
and place them side by side or on different monitors. Selecting a popped-out
session in the sidebar focuses its window.

Use **Return to main window**, **Ctrl+W**, or the window's close button to bring
the session back without stopping its CLI process. **Close session** in the main
app still stops the session and closes its pop-out. Quitting the app stops all
sessions, including pop-outs. Window placement resets on the next app launch.
Moving a terminal replays the app's bounded recent output; it does not restart
the CLI or change the saved conversation.

Run `pnpm popout:check` for the isolated real Electron/CLI regression check
(requires an installed Copilot CLI; model responses come from a loopback fixture).

## Side chats

Click the **Fork into side chat** button (branch icon) in the header above a local terminal, check the source session UUID,
and choose **Fork side chat**. The right-hand pane has its own terminal and input;
drag the divider (or focus it and use the arrow keys) to resize it. One side chat
can be open per main tab. Both panes count toward the 20-tab limit.

- The source UUID is the last one known to Desktop. Native `/fork`, `/resume`,
  `/new`, and `/clear` can change the CLI conversation without notifying Desktop;
  use `/session` to check the current UUID and correct it in the fork dialog.
- Only complete saved history is copied. Future messages do not merge between
  the two conversations, and unfinished output may not yet be included.
- Closing the side leaves the main running. Closing the main keeps its side as
  an independent restricted tab. Open pairs and their restrictions are restored
  when the workspace's tabs are restored after an app restart.
- Side chats expose only `view`, `glob`, `grep`, and `ask_user` to the model.
  Both processes still share files: this is **not an OS sandbox**, and it does
  not isolate local CLI hooks or manually entered commands.

Requires Copilot CLI **1.0.82+** and tool-allowlist support. The desktop stages a
snapshot of the source's persisted session directory in a temporary
`COPILOT_HOME`, asks Copilot's `sessions.fork` RPC to fork that copy, then publishes
only the new child. This avoids a source-log truncation observed when 1.0.82 forks
an unloaded source through a separate helper. No embedded TCP server is enabled.
Symlink-containing sessions and unknown history formats fail closed. Staging is
removed after the operation; source history and live processes are never replaced.
History validation streams fixed-size chunks and compares ordered message hashes,
yielding to terminal/IPC work between chunks. Histories over 128 MiB or individual
records over 8 MiB are rejected with an explanation to bound resource usage.

Run `pnpm fork:smoke` for the isolated live-CLI test (local mock model, no paid
requests), or `pnpm side-chat:preview` for the renderer fixture.
After building, `node scripts/electron-side-chat-check.mjs` opens the real
Electron app with a disposable profile, saved conversation, and local mock model
for a manual end-to-end check; close that test app to clean up its data.
Run `npm run clipboard:smoke` for the automated native-copy → new-session →
return regression in the real app and CLI. It uses the same disposable data
and local mock model, and saves screenshots plus `result.json` under
`test-results/clipboard-switch/` (no paid model requests).
Run `npm run paste:check` to verify text, images, multiline input, and pop-out
paste with the real CLI and a local mock model. Screenshots and request evidence
are saved under `test-results/native-paste/` (no paid model requests).
The live paste check temporarily uses the OS clipboard and restores its original
text/image formats if it still owns the clipboard. It stops before changing copied
files or custom clipboard formats; copy plain text first in that case. If you copy
something new during the run, the check preserves it and prints a notice.
Run `npm run links:check` for the isolated Electron/React/xterm click regression.
It checks file and URL routing, IPC error messages, notice layout and dismissal,
and tab-switch races without opening external applications. Results and screenshots
are saved under `test-results/terminal-links/`.
For paths containing spaces, use quotes or backticks with an explicit path prefix
(for example, `./folder name/file.txt` or an absolute Windows path). Inline-code
commands keep their embedded file links; a missing target shows a neutral notice.
After building, run `node scripts/electron-side-chat-check.mjs --clipboard-multi-click`
to test drag-select → double-click → Ctrl+C, including the physical Control-key
sequence. Its screenshots and results are saved under `test-results/clipboard-multi-click/`.
Use `node scripts/electron-side-chat-check.mjs --clipboard-status` to compare the
first and second copy confirmations' color and terminal-row alignment. Screenshots
and measurements are saved under `test-results/clipboard-status/`.

## Review meetings

A meeting lets several sessions review one session's plan or local changes without copying anything or pushing a branch.

1. In the session that wrote the plan or made the changes, ask: **"start a meeting to review your plan"** (or "…your local
   changes"). Copilot writes the material to a file and runs the meeting helper; it tells you the meeting id, for example
   **K7QF**.
2. In each session that should review it (any project, any model, read-only sessions too), type **"join meeting K7QF"**,
   or give it a role: **"join meeting K7QF as security reviewer"**. **Add session…** on the meeting bar does the same, with
   an optional role in the box beside it. A reviewer with a role is asked to look at the material from that angle first.
3. The desktop does the rest, in rounds. It types the host's post (and its uncommitted changes, as a patch) into every
   reviewer, collects their replies, and gives them all to the host in one message. The host answers or revises, and the
   next round goes out, with what the other reviewers said. When the open items are settled the host proposes to close;
   each reviewer answers AGREE or OBJECT. When everyone agrees the meeting closes, and the host goes on with whatever you
   asked it to do after the meeting.

- The desktop types a meeting message only when that session is idle and its prompt box is empty, the same moment it uses
  for `/rename`. Type into any session at any time; the meeting waits for it.
- The meeting bar above a session in a meeting shows the round, whom it waits for, each reviewer's role, and what the
  meeting has cost so far: the AI credits (and premium requests, if any) its sessions used since they joined, read from
  each session's own usage records, with **Transcript** and **Stop**.
  A meeting pauses at its round limit (Settings, default 6) and asks whether to allow 3 more rounds. A round stops waiting
  for a reviewer after the round timeout (Settings, default 10 minutes).
- **Reviewers answering each other** (Settings, off by default): with two or more reviews in a round, each reviewer reads the
  others' reviews and answers them in one more turn: where it agrees, where it disagrees, and what changes in its own
  review. The host then gets the reviews and that discussion together. It costs one more turn per reviewer per round;
  votes are not discussed.
- Only you start and join meetings: a join counts only from a message you typed, and a host can start one only while it
  answers your own message. Reviewers are told to review only; a reviewer that runs Full auto or Full access can still act
  on what it reads, so prefer Restricted reviewers.
- The shared patch gets the same protection as the Git panel's prompts: files that hold secrets by convention (`.env`,
  keys, credentials) are named but their changes are withheld, and values that look like credentials are masked. This
  catches the common shapes, not every secret: review what you share.
- Only running sessions can join; resume an unloaded session first. Unloading or closing a session takes it out of its
  meeting (closing the meeting, for the host). A reply that arrives after its round timed out is passed on as a late reply,
  never counted for a later round or vote.
- The material and transcript live in `%APPDATA%\Copilot CLI Desktop\meetings\<id>`; the desktop adds that folder to each
  session with `/add-dir`. Folders are removed a week after their last change. Remote sessions cannot take part.
- An open meeting survives an app restart. Its state is saved in `meeting.json` with each session's Copilot session id; at
  the next start the desktop finds those sessions among the restored tabs, starts them, adds the folder again, and sends
  again whatever a session had been given and not finished answering. A round being reviewed starts its timeout over. A
  reviewer whose tab is gone leaves the meeting; if the host's tab is gone, the meeting closes.
- The host needs a session started (or resumed once) by this version, so that it has the meeting helper. The helper runs in
  the host's own shell, so it asks for approval like any other command unless the session allows it.

### Outside agents as reviewers

An agent that is not a Copilot tab of this app, such as Claude Code, Codex CLI or Gemini CLI, can review in a meeting if it
runs on the same computer and has MCP or a shell tool.

1. On the meeting bar, press **Invite outside agent…**, give the agent a name and, optionally, a role, and press **Copy
   invitation**.
2. Paste the invitation into that agent. It reviews in a loop, with the meeting tools if it has them, otherwise with the
   guest helper:
   - **Meeting tools (MCP):** `meeting_join` with the invitation, then `meeting_next` (waits up to 50 seconds for its
     next message), `meeting_reply` with its answer, and `meeting_show` for material too long to include, in pages.
   - **Guest helper:** `next` (waits up to 100 seconds), `reply` with a file, and `show`.
3. The agent joins with its first `meeting_next` or `next` and then reviews and votes like any other reviewer. The meeting
   bar lists it as a guest, with **Remove**, and says when it stopped polling.

The meeting tools are served by the desktop at `http://127.0.0.1:47391/mcp`, a streamable HTTP MCP server. Add it to an
agent once; it needs no key, because the tools do nothing without an invitation. For Claude Code:

```bash
claude mcp add --transport http copilot-meeting http://127.0.0.1:47391/mcp
```

Other agents take the same URL in their MCP settings. The invite form shows the command with **Copy**. If the port is
taken, invitations leave the tools out and the helper still works. On Windows, prefer the tools with Claude Code: its
PowerShell tool refuses to start `powershell.exe -File`, which the helper needs, while its Bash tool runs it.

- Only you invite: an invitation is made only from the meeting bar. Its token works for that one agent in that one meeting
  and stops working when the agent leaves, is removed or the meeting closes. An invitation nobody uses expires after 15
  minutes. Tokens are saved only as hashes, outside the meeting folder.
- The agent's own model provider sees the plan, the patch and the other reviews. Patches are filtered as for any reviewer.
- The agent is told to review only, but the desktop cannot enforce that on another harness: run it in a mode that asks
  before editing files. Allowing the meeting tools, or the helper's command, once saves approving every poll.
- With the helper, the agent writes each reply to a file the desktop names in `%APPDATA%\Copilot CLI Desktop\meeting-guest\`,
  never into its own project; with the tools, the reply is the tool's argument. The helper and `endpoint.json` (the desktop's
  port, no token) live in that folder too, so a guest keeps working after an app restart. With the tools, an agent joins
  again with the same invitation after a restart.
- An outside agent's usage is billed by its own provider; the meeting bar's cost counts Copilot sessions only. A guest that
  keeps one turn polling costs one small model call each time a wait ends with nothing (50 seconds with the tools, 100 with
  the helper), more as its conversation grows.
- An outside agent that lets two rounds in a row pass without a reply (it stopped polling) is taken out of the meeting, so
  the rounds stop waiting for it; the transcript says so. Copilot sessions are never taken out this way.
- If an agent switches between the tools and the helper (for example when the tools' port is taken after a restart), the
  message it has not answered yet is reworded for the way it now asks.

### An outside agent as host

An outside agent can also host: Copilot sessions (and other agents) review its plan or changes.

1. Choose **File → Host a Meeting from an Outside Agent…**. To let the agent attach its uncommitted changes, pick its
   project folder; the host invitation goes to the clipboard.
2. Paste it into the agent with what you want reviewed, for example "review your plan with Copilot, then implement it".
3. The agent starts the meeting (`meeting_start`, or the helper's `start`). Its meeting bar appears above your tabs: add
   Copilot sessions with **Add session…**, or invite other agents.
4. The agent waits for each round's replies with `meeting_next` and answers with `meeting_round`, or proposes to close
   with `meeting_propose_close`. When everyone agrees, it gets the agreed message and carries on.

- Only you make host invitations. One starts a single meeting and expires after 15 minutes unused.
- The changes come from the folder you picked, and only from inside it (a subfolder of a repository attaches just that
  subfolder's changes): the desktop runs Git there as the Git panel does, with the same hardening
  and the same trust check. If the repository's own Git settings name a program (a filter, for example), accept them in
  the Git panel first; until then the agent is told the changes cannot be attached. The patch is filtered as for any
  meeting. Without a folder, the agent describes its changes in its post. A repository around your home folder or a
  drive root (a dotfiles repository, say) is never used for a folder inside it: pick the project's own repository.
- If the host asks for the same replies again without answering them, it is reminded once; the next time the meeting
  pauses, as for a Copilot host that lets a turn pass. **Stop** on the meeting bar ends it at any time.

## Permission presets

Copilot CLI exposes the runtime modes `manual`, `assisted`, and `allow-all`,
plus launch-time flags such as `--available-tools`, `--allow-all-tools`, and
`--add-dir`. This app maps five startup presets onto that surface. A workspace
profile supplies the default only when a new session is created; every tab
then owns and persists its permission independently:

| Preset | Flags applied | Behavior |
| --- | --- | --- |
| Copilot default | (none) | Uses Copilot CLI's configured `defaultPermissionMode`. A normal installation prompts for mutating actions, but an upstream allow-all setting remains allow-all. |
| Restricted | `--available-tools=view,glob,grep,ask_user` | Only explicit read/search/interaction tools are visible to the model. Shell, write, web, MCP, skill, memory, and delegated-agent tools are excluded. |
| Trusted directory | `--add-dir <workspace>` | The workspace is trusted, but mutating actions still prompt individually. |
| Full auto | `--allow-all-tools` | Every tool call is approved automatically. Use only for fully-trusted workspaces. |
| Full access | `--allow-all` | Enables Copilot's broadest documented approval mode. Use only in an isolated, fully-trusted environment. |

Inside an existing terminal, permission changes made through Copilot's direct
commands, history recall, completion, or permission picker update that
session's approval-mode badge without changing its profile. The desktop reads
Copilot's structured `session.permissions_changed` records rather than parsing
terminal prose. Restarting or restoring a tab reapplies its original launch
flags; Copilot restores its own durable runtime approval mode. Observed mode
changes never add `--allow-all` to a session's startup flags. Full auto and Full
access startup flags remain enabled even when the native runtime override is
removed; the badge shows this baseline. The profile default applies only to new
sessions. A Restricted session or side chat can change its approval mode, but
its launch-time read/search tool allowlist remains visible in the badge.

See `src/main/permission-presets.ts`.

## Session resume

The sidebar distinguishes the open CLI process from its task activity:
**Working** means a root assistant turn is in progress; **Idle** follows a final
response or cancellation. A tool-call or otherwise inconclusive turn end shows
**Open** until another turn begins: the process is alive but task activity is unknown
(for example, before the first turn or for remote sessions). These are observed
from saved CLI events, so updates can lag by a few seconds. Quiet output alone
does not mark a session idle, and background subagent completion does not mark
the main task finished. Dropped oversized events clear activity evidence and
report a diagnostic; later complete turns can establish activity again.

While a session is working, its sidebar row shows what it is doing and for how long:
**Thinking** during a model call, or the tools running right now (**Running command**,
**Viewing** or **Editing** a file, **Searching**, **Fetching**, **Asking you**, or
**Running tool** for anything else, including MCP tools) with an elapsed clock. File tools
show only the file name; shell commands and tool descriptions are never shown, and tool
titles come from a fixed list rather than from the event log. The line comes from the same
saved CLI events, so it can lag by a few seconds and is empty where those events are not
available (remote sessions, older CLIs). A pending approval always replaces it.

Each tab tracks a resume mode (per workspace profile, overridable per tab):

- **New** — starts a fresh session with a generated UUID and Copilot-visible
  name when the installed CLI exposes `--session-id` and `--name`.
- **Auto-resume** — uses `--resume <id>` with the UUID assigned when the tab
  was created; older CLI versions that cannot accept a desktop-assigned UUID
  start a new session if no trusted id is known.
- **Continue** — always uses `--continue` (resumes the most recent session,
  preferring the current working directory).
- **Picker** — used by the "Resume session…" button; runs `copilot --resume`
  with no id, so Copilot CLI's own interactive session picker renders
  directly inside the xterm pane.

See `src/main/resume-args.ts`.

## Heuristics — read before relying on them

The interactive TUI exposes a terminal stream rather than structured lifecycle
events, so approval detection remains a best-effort regex heuristic:

- **Approval-prompt detection** (`src/main/approval-heuristic.ts`,
  `detectApprovalPrompt`) badges a tab "needs approval" and raises a
  notification when recent output resembles a prompt (`"Allow ... ?"`,
  `[y/n]`, "Do you want to proceed?", etc.). It will both miss real prompts
  and misfire on unrelated text that merely resembles one.

Session IDs are never inferred from terminal output. Current releases receive
a UUID before launch, so untrusted terminal text cannot redirect later resume
or fork operations.

The resolver and real pty launch path are exercised against Copilot CLI in
local smoke testing. Approval detection still requires maintenance if the
CLI's human-readable output changes.

## Copilot CLI automatic updates

Copilot CLI's native automatic updater is enabled by default on the stable
channel and runs when a session starts. Settings can disable it or opt into the
prerelease channel. The desktop app re-detects the installed version without
restarting; a session that was already running keeps its original executable
and receives an **Old CLI** badge until that session is restarted (or, for a
remote connection, closed and reconnected). The manual update action remains
available, but requires all active sessions to be closed.

## Requirements

- Windows 10 or later, macOS 12 or later, or a 64-bit Linux desktop for the packaged application.
- Node.js 24 and pnpm 11.5.3 for source development and the CLI.
- The [`copilot` CLI](https://github.com/github/copilot-cli) itself to
  actually spawn sessions. On Windows it can also be installed or repaired from Desktop Settings using
  the official WinGet package. Verified npm installations remain
  supported for launch, but the desktop never runs npm lifecycle scripts to install one.
  On macOS and Linux, install it with npm or your package manager; the desktop reads your login
  shell's `PATH` at startup, so it finds what your terminal finds even when opened from Finder or a launcher.
  Neither is required to build, typecheck, or run the unit tests.
- Git 2.30 or newer, only for the Git panel (Git for Windows on Windows; on macOS, the Command
  Line Tools or Homebrew Git). Everything else works without it.
- On macOS and Linux, `curl`, for Copilot's browser and review-meeting helpers.

`node-pty` 1.x's native addon is built on `node-addon-api` (N-API), which is
ABI-stable across Node.js and Electron — no `@electron/rebuild` or other
native-rebuild step is required. This was verified in this repository's setup
by loading the package's prebuilt Windows binary both under plain Node and
under Electron (`ELECTRON_RUN_AS_NODE=1`) with no rebuild. node-pty ships prebuilt
binaries for Windows and macOS; on Linux `pnpm install` compiles it, which needs Python, `make` and a C++ compiler.

## Platforms

The features are the same on all three platforms, except:

| | Windows | macOS | Linux |
|---|---|---|---|
| Copilot's browser and meeting helpers | `browser.ps1`, `meeting.ps1` (Windows PowerShell) | `browser.sh`, `meeting.sh` (`sh` and `curl`) | same as macOS |
| Shortcut key | Ctrl | Cmd; Ctrl keys go to the terminal | Ctrl |
| Saved secrets | DPAPI | Keychain | libsecret or KWallet; without one, saving is refused |
| Launch at login | login item | login item | `~/.config/autostart` entry |
| In-app updates | installer | not available unsigned: download from Releases | AppImage only; a `.deb` updates through the package manager |
| Migration (Settings → Migration) | yes | no | no |
| Network shares in Git folders | refused | not detected (a network mount looks like a local folder) | same as macOS |

macOS builds are not signed or notarized unless the release has an Apple Developer ID, so
macOS asks you to confirm the first time you open the app (System Settings → Privacy & Security → Open Anyway).

## Development

```powershell
corepack enable
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
corepack pnpm smoke
corepack pnpm start
```

`pnpm smoke` and `pnpm cli:smoke` are best-effort: without a real `copilot`
binary on PATH they log that and exit successfully.
With `copilot` installed locally, `pnpm smoke` resolves it and spawns a real,
short-lived pty session end to end.

## First run and the credential vault

Choose a workspace folder from the main window, then open **File → Desktop
Settings** to rename a profile, configure its permission preset and resume
mode, select a provider, and save protected credentials. Paste only the value (for example
`sk-...`), not a `NAME=value` assignment. The desktop app encrypts each value
with Windows DPAPI (`safeStorage`) and decrypts it only for an authenticated
interactive Copilot session. Vault credentials are not exposed to renderers,
resource installers, or unrelated helper processes; fork helpers also receive
Copilot's secret-environment masking flags. An environment variable already
set on the machine always takes precedence over a saved vault entry.

The vault is global to the desktop app: a saved credential applies to every
workspace profile's spawned sessions, since these are process environment
variables, not per-project configuration.

## Tray, notifications, and workspace profiles

Closing the main window hides it while every session tab keeps running,
unless disabled in Settings. Use the tray icon to reopen the window, start a
new session tab, open Settings, or quit. Native notifications fire on
approval-needed, session-completed, and session-crashed (also toggleable);
clicking one focuses the window and the relevant tab.

Workspace profiles are keyed by normalized folder path and remember a name,
startup permission, default resume mode, launch profile, and the last set of
open tabs (title + deterministic session id + session-owned permission on
current Copilot versions) to restore next time that profile is activated.

## Background CLI

Run from the repository with `pnpm cli -- <command>`, or use
`copilot-desktop` after installing/linking the package as a CLI.

```powershell
copilot-desktop start .                          # start copilot for the current directory
copilot-desktop start D:\work\my-project --preset trusted-directory --resume-mode continue
copilot-desktop status
copilot-desktop status --json
copilot-desktop run . --prompt "Review this repository" --agent code-review --output-format json
copilot-desktop run D:\work\my-project --prompt "Fix the tests" --autopilot --max-ai-credits 5
copilot-desktop restart
copilot-desktop logs --tail 100
copilot-desktop stop
```

The controller state and private, 5 MiB rotating log live under
`%APPDATA%\copilot-cli-desktop\cli`. Its private HTTP control server uses a
random bearer token and listens only on `127.0.0.1`. Only one controller is
supported per Windows user; set `COPILOT_DESKTOP_CLI_HOME` to isolate state
for automation.

The `run` command uses Copilot's official programmatic `--prompt` mode and
inherits stdout/stderr so it can be composed with scripts. It also
protects configured token variables with `--secret-env-vars`.

**The long-running background controller spawns `copilot` as a plain piped child process, not a
real pty** (`src/main/child-process-pty-backend.ts`) — there is no terminal
UI attached to a detached background process to render into. `copilot`'s
actual behavior without a real tty attached is unverified here; for full
interactive TUI behavior, use the desktop app's session tabs instead. This is
a deliberate, documented simplification, not an oversight.

`pnpm cli:smoke` verifies the parts of the start/status/restart/logs/stop
lifecycle that do not require a real `copilot` binary, and otherwise logs
that a full run needs one installed locally.

## Windows packaging

```powershell
pnpm pack:win   # unpacked application
pnpm dist:win   # NSIS installer
```

Artifacts are written to `release/`. Local and explicitly manual historical
builds may be unsigned. Automated public tagged releases require the GitHub
Actions secrets `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`; without them
the release workflow ends with a notice, builds nothing and publishes nothing, so
unsigned publication stays impossible without failing the run. Packaging audits the archive, native
`node-pty` addon, required executables, Electron fuses, and production-only files.

## macOS and Linux packaging

```bash
pnpm dist:mac     # dmg and zip, arm64 and x64 (on a Mac)
pnpm dist:linux   # AppImage and deb, x64 (on Linux)
```

Both run the same package audit as Windows. CI builds both, unsigned, on every push.

## Releases

Pushing a tag such as `v0.1.0` runs `.github/workflows/release.yml`, which builds the NSIS
installer and publishes it plus `latest.yml` (required by the in-app updater) to a GitHub
release. It refuses to publish without Windows code signing. Then it dispatches
`.github/workflows/release-unix.yml` (which also runs when a person publishes a release), which builds the macOS and Linux
packages from the tag and adds them,
with `latest-mac.yml` and `latest-linux.yml`, to the same release. macOS builds are signed and
notarized when the `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`
and `APPLE_TEAM_ID` secrets are set, and unsigned otherwise. The detailed DeepSeek Harness
comparison and every applicability decision are recorded in
[`docs/FEATURE_PARITY.md`](docs/FEATURE_PARITY.md).

## Live-verification boundary

Copilot CLI resolution and real pty startup are verified locally. Approval
prompt wording, every upstream provider account, and every possible resume
history remain dependent on Copilot CLI and account state. Pure logic
(permission-preset mapping, tab state, resume arguments,
provider environment, encrypted-vault serialization, and pty lifecycle) is
covered by unit tests and does not depend on a live account.

## License

This project is MIT licensed. See `LICENSE`.
