# Copilot CLI Desktop

A Windows-first Electron desktop shell and background CLI for the
[GitHub Copilot CLI](https://github.com/github/copilot-cli) (`copilot`).

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

- Resolves the `copilot` binary (PATH, legacy GitHub CLI-managed location,
  then a compatible `gh copilot --` installation), and shows a recovery dashboard with install/retry actions
  and a copyable diagnostic summary when it cannot be found.
- A standard collapsible AI-tool sidebar with workspace/session search,
  grouped or flat session views, manual/last-activity ordering, named recent
  workspace profiles, manual session naming, attachment-aware session
  creation, and restored session tabs.
- **Fork into side chat** keeps a main conversation on the left and an independent,
  resizable conversation on the right. Side chats use read/search-only model tools,
  including after restart, and can be closed without stopping the main session.
- Session identity and resume: each fresh tab gets a desktop-generated UUID
  through `--session-id` and a Copilot-visible `--name`, then auto-resumes with
  `--resume <id>` (or `--continue`) when reopened, plus a
  manual "Resume session…" action that opens `copilot --resume`'s own
  interactive picker directly inside the terminal pane.
- Per-session pty process supervision: crash detection, a restart action, and
  private per-session log capture under the app's user-data directory. Logs
  rotate at 5 MiB; launch directories are limited to 7 days and the latest 20.
- Native session tabs (Ctrl+T new, Ctrl+W close) bound to one pty session
  each, with lifecycle badges (starting / running / needs-approval / stopping
  / completed / crashed) restored per workspace profile.
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
  (Windows DPAPI via Electron `safeStorage`) protects
  `COPILOT_PROVIDER_API_KEY`, the legacy `COPILOT_PROVIDER_BASE_URL`, and the
  supported GitHub token overrides `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and
  `GITHUB_TOKEN`. If protected storage is unavailable, saving is refused
  instead of silently falling back to plaintext.
- Per-workspace Copilot launch profiles for model, reasoning effort, context
  tier, custom agent, interactive/plan/autopilot/plan-then-autopilot mode,
  AI-credit and continuation limits, worktrees, screen readers, remote control,
  and session-export privacy.
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
  detached Windows watchdog covering abrupt desktop-process termination.
- A background CLI (`copilot-desktop`) with a token-protected, loopback-only
  HTTP control server (`start` / `status` / `restart` / `logs` / `stop`) and a
  first-class `run --prompt` command for official non-interactive Copilot
  execution, JSONL output, custom agents, models, and transcript export.
- Windows packaging via `electron-builder` (NSIS), post-package runtime
  auditing, Windows CI, scheduled compatibility checks against the latest
  Copilot CLI, and signed tag-triggered releases with unsigned publication
  blocked.

## Side chats

Click **Fork into side chat** above a local terminal, check the source session UUID,
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

## Permission presets

`copilot` has no single named permission-mode enum. It exposes flags instead:
`--available-tools`, `--excluded-tools`, `--allow-tool`, `--deny-tool`,
`--allow-all-tools` (`/yolo`), `--allow-url`, and `--add-dir` (trust a
directory permanently). This app maps five presets
onto that flag surface, set per workspace profile in Settings:

| Preset | Flags applied | Behavior |
| --- | --- | --- |
| Copilot default | (none) | Uses Copilot CLI's configured `defaultPermissionMode`. A normal installation prompts for mutating actions, but an upstream allow-all setting remains allow-all. |
| Restricted | `--available-tools=view,glob,grep,ask_user` | Only explicit read/search/interaction tools are visible to the model. Shell, write, web, MCP, skill, memory, and delegated-agent tools are excluded. |
| Trusted directory | `--add-dir <workspace>` | The workspace is trusted, but mutating actions still prompt individually. |
| Full auto | `--allow-all-tools` | Every tool call is approved automatically. Use only for fully-trusted workspaces. |
| Full access | `--allow-all` | Enables Copilot's broadest documented approval mode. Use only in an isolated, fully-trusted environment. |

See `src/main/permission-presets.ts`.

## Session resume

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

- Windows 10 or later for the packaged desktop application.
- Node.js 24 and pnpm 11.5.3 for source development and the CLI.
- The [`copilot` CLI](https://github.com/github/copilot-cli) itself on PATH to
  actually spawn sessions. It can also be installed or repaired from Desktop Settings using
  the official Windows WinGet package. Verified npm installations remain
  supported for launch, but the desktop never runs npm lifecycle scripts to install one.
  Neither is required to build, typecheck, or run the unit tests.

`node-pty` 1.x's native addon is built on `node-addon-api` (N-API), which is
ABI-stable across Node.js and Electron — no `@electron/rebuild` or other
native-rebuild step is required. This was verified in this repository's setup
by loading the package's prebuilt Windows binary both under plain Node and
under Electron (`ELECTRON_RUN_AS_NODE=1`) with no rebuild.

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
binary on PATH they log that and exit successfully rather than failing CI.
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
permission preset, default resume mode, launch profile, and the last set of
open tabs (title + deterministic session id on current Copilot versions) to
restore next time that profile is activated.

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
inherits stdout/stderr so it can be composed with scripts and CI. It also
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
Actions secrets `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`; the release
workflow refuses unsigned publication. Packaging audits the archive, native
`node-pty` addon, required executables, Electron fuses, and production-only files.

## Continuous integration and releases

The Windows CI workflow (`.github/workflows/ci.yml`) type-checks, runs unit
tests, runs the best-effort smoke tests, and builds an unpacked application.
Pushing a tag such as `v0.1.0` runs the same checks, builds the NSIS
installer, and publishes it plus `latest.yml` (required by the in-app
updater) to a GitHub release.

The scheduled compatibility workflow (`.github/workflows/cli-compatibility.yml`)
installs the latest Copilot CLI each week and reruns the type, unit, smoke, and
CLI lifecycle checks. The detailed DeepSeek Harness comparison and every
applicability decision are recorded in [`docs/FEATURE_PARITY.md`](docs/FEATURE_PARITY.md).

## Live-verification boundary

Copilot CLI resolution and real pty startup are verified locally. Approval
prompt wording, every upstream provider account, and every possible resume
history remain dependent on Copilot CLI and account state. Pure logic
(permission-preset mapping, tab state, resume arguments,
provider environment, encrypted-vault serialization, and pty lifecycle) is
covered by unit tests and does not depend on a live account.

## License

This project is MIT licensed. See `LICENSE`.
