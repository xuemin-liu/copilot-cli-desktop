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

- Resolves the `copilot` binary (PATH, then the location `gh` downloads it to,
  then `gh copilot --`), and shows a recovery dashboard with a retry action
  and a copyable diagnostic summary when it cannot be found.
- Workspace folder picker with named recent-workspace profiles, each with its
  own permission preset and restored session tabs.
- Session resume: each tab remembers a best-effort captured session id and
  auto-resumes with `--resume <id>` (or `--continue`) when reopened, plus a
  manual "Resume session…" action that opens `copilot --resume`'s own
  interactive picker directly inside the terminal pane.
- Per-session pty process supervision: crash detection, a restart action, and
  per-session log capture to disk under the app's user-data directory.
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
- A secure credential vault (Windows DPAPI via Electron `safeStorage`) for the
  three environment variables `copilot` reads: `COPILOT_PROVIDER_BASE_URL`
  and `COPILOT_PROVIDER_API_KEY` (bring-your-own-key), and an optional
  `GH_TOKEN` override. If protected storage is unavailable, saving is refused
  instead of silently falling back to plaintext.
- Stops the full process tree for every running session on app quit.
- A background CLI (`copilot-desktop`) with a token-protected, loopback-only
  HTTP control server: `start` / `status` / `restart` / `logs` / `stop`.
- Windows packaging via `electron-builder` (NSIS) and a Windows GitHub Actions
  CI workflow plus a tag-triggered release workflow.

## Permission presets

`copilot` has no single named permission-mode enum. It exposes flags instead:
`--allow-tool`, `--deny-tool`, `--allow-all-tools` (`/yolo`), `--allow-url`,
and `--add-dir` (trust a directory permanently). This app maps three presets
onto that flag surface, set per workspace profile in Settings:

| Preset | Flags applied | Behavior |
| --- | --- | --- |
| Default | (none) | Read-only actions run automatically; every mutating action (shell, edits, URL fetches, MCP tools) prompts. |
| Trusted directory | `--add-dir <workspace>` | The workspace is trusted, but mutating actions still prompt individually. |
| Full auto | `--allow-all-tools` | Every tool call is approved automatically. Use only for fully-trusted workspaces. |

See `src/main/permission-presets.ts`.

## Session resume

Each tab tracks a resume mode (per workspace profile, overridable per tab):

- **New** — always starts a fresh session.
- **Auto-resume** — uses `--resume <id>` with a session id best-effort
  captured from prior pty output (see the heuristic caveat below); falls back
  to a new session if no id is known yet.
- **Continue** — always uses `--continue` (resumes the most recent session,
  preferring the current working directory).
- **Picker** — used by the "Resume session…" button; runs `copilot --resume`
  with no id, so Copilot CLI's own interactive session picker renders
  directly inside the xterm pane.

See `src/main/resume-args.ts`.

## Heuristics — read before relying on them

**`copilot` was not installed in the environment this project was built in**,
so two behaviors are best-effort regex heuristics over raw pty output, not a
structured protocol:

- **Approval-prompt detection** (`src/main/approval-heuristic.ts`,
  `detectApprovalPrompt`) badges a tab "needs approval" and raises a
  notification when recent output resembles a prompt (`"Allow ... ?"`,
  `[y/n]`, "Do you want to proceed?", etc.). It will both miss real prompts
  and misfire on unrelated text that merely resembles one.
- **Session id capture** (`extractSessionId` in the same file) scans for
  patterns like `Session ID: <id>` to populate auto-resume. If `copilot`'s
  real banner text doesn't match, auto-resume silently falls back to a new
  session instead of resuming.

If you have `copilot` installed, please verify these against its actual
output and adjust the patterns — that is the single highest-value follow-up
for this project.

## Requirements

- Windows 10 or later for the packaged desktop application.
- Node.js 24 and pnpm 11.5.3 for source development and the CLI.
- The [`copilot` CLI](https://github.com/github/copilot-cli) itself, or the
  [GitHub CLI](https://cli.github.com/) with the Copilot extension
  (`gh extension install github/gh-copilot`), on PATH to actually spawn
  sessions. Neither is required to build, typecheck, or run the unit tests.

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
Settings** to configure a workspace's permission preset and resume mode, and
to save protected credentials. Paste only the value (for example
`sk-...`), not a `NAME=value` assignment. The desktop app encrypts each value
with Windows DPAPI (`safeStorage`) and decrypts it only into the environment
of the pty process it spawns — it is never sent back to any renderer. An
environment variable already set on the machine always takes precedence over
a saved vault entry.

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
permission preset, default resume mode, and the last set of open tabs (title
+ best-effort captured session id) to restore next time that profile is
activated.

## Background CLI

Run from the repository with `pnpm cli -- <command>`, or use
`copilot-desktop` after installing/linking the package as a CLI.

```powershell
copilot-desktop start .                          # start copilot for the current directory
copilot-desktop start D:\work\my-project --preset trusted-directory --resume-mode continue
copilot-desktop status
copilot-desktop status --json
copilot-desktop restart
copilot-desktop logs --tail 100
copilot-desktop stop
```

The controller state and log live under
`%APPDATA%\copilot-cli-desktop\cli`. Its private HTTP control server uses a
random bearer token and listens only on `127.0.0.1`. Only one controller is
supported per Windows user; set `COPILOT_DESKTOP_CLI_HOME` to isolate state
for automation.

**The background CLI spawns `copilot` as a plain piped child process, not a
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

Artifacts are written to `release/`. Local installers are unsigned; configure
the GitHub Actions secrets `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`
for the release workflow to produce a signed installer.

## Continuous integration and releases

The Windows CI workflow (`.github/workflows/ci.yml`) type-checks, runs unit
tests, runs the best-effort smoke tests, and builds an unpacked application.
Pushing a tag such as `v0.1.0` runs the same checks, builds the NSIS
installer, and publishes it plus `latest.yml` (required by the in-app
updater) to a GitHub release.

## What was NOT verified live

`copilot` is not installed in the environment this project was built in.
Everything above involving the real CLI's actual output, prompts, or resume
semantics — approval-prompt text, session-id banner format, `--resume` /
`--continue` exact behavior, and BYOK environment variable names — was
implemented from the publicly documented behavior and needs verification
against the real binary. Pure logic (permission-preset → flag mapping,
session-tab state machine, resume-argument builder, credential vault
serialization, and the pty-session lifecycle with a mocked pty backend) is
covered by unit tests (`pnpm test`) and does not depend on the real binary.

## License

This project is MIT licensed. See `LICENSE`.
