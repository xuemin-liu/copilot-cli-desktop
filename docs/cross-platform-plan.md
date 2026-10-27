# macOS and Linux support: plan

Status: built on branch `feat/cross-platform`, all seven steps. Verified by the unit tests on Windows, macOS and Linux in
CI (`.github/workflows/ci.yml`), and by building unsigned macOS and Linux packages there. Not yet verified: running the
packaged app on a real Mac or Linux desktop, signing and notarization (no Apple Developer ID yet), and the Electron
integration checks in `scripts/` (they still launch Windows PowerShell). The table below is the assessment the work
started from.

## Where the app stood before

The app does not support macOS or Linux. It is Windows-first by design: the only build target is the Windows NSIS
installer, the release workflow runs only on `windows-latest`, and the README lists Windows 10 or later as the
requirement. Some parts were written with other platforms in mind (`CmdOrCtrl` menu accelerators, the `activate`
handler, a `SIGTERM`/`SIGKILL` branch when stopping a session, an XDG state folder for the background CLI), but nothing
has been built, run or tested on macOS or Linux.

This assessment comes from reading the code on Windows; none of it has been run on another platform. The first step of
the plan below is to get that evidence.

| Area | macOS / Linux today | Where |
|---|---|---|
| Packaging and release | No mac or Linux target, release CI on Windows only, auto-update gated to Windows | `package.json` `build`, `.github/workflows/release.yml`, `main.ts` (updater) |
| Terminal (node-pty) | Prebuilt binaries for macOS x64/arm64; **none for Linux**, so a Linux build must compile it | `node_modules/node-pty/prebuilds` |
| Finding the Copilot CLI | Runs `copilot --version` from `PATH`. Works from a terminal, but an app opened from Finder or a desktop launcher does not get the shell's `PATH` (Homebrew, npm global, nvm), so it usually fails | `resolve-copilot.ts` |
| Installing the Copilot CLI | WinGet only; elsewhere it throws "supported only on Windows" | `copilot-maintenance.ts` |
| Git panel | **Unavailable**: Git lookup accepts only an absolute `git.exe` | `git-runner.ts` `resolveGitExecutable` |
| Git and worktree paths | **Wrong on POSIX**: about 70 uses of `path.win32` build backslash paths (`/home/a` becomes `\home\a`) and compare folders case-insensitively, which is wrong on Linux | `git-discovery.ts`, `git-discard.ts`, `git-untracked.ts`, `git-hooks.ts`, `git-trust.ts`, `git-env.ts`, `session-worktree-launch.ts`, `session-worktree-cleanup.ts`, `session-store-discovery.ts`, `main.ts`, `external-targets.ts` |
| Stopping processes | Kills only the top process, not its children (Git's ssh, hooks, the CLI's tools). No equivalent of the Windows watchdog that cleans up after the app crashes | `git-runner.ts`, `copilot-rpc.ts`, `pty-session.ts`, `windows-process-watchdog.ts` |
| Browser and meeting tools for Copilot | **Unavailable**: the helpers are PowerShell scripts run as `powershell.exe`, and the instructions use `$env:` syntax | `browser-session.ts`, `browser-test-helper.ts`, `meeting-session.ts`, `meeting-messages.ts` |
| Keyboard shortcuts | The renderer checks `ctrlKey` in six files; macOS users expect Cmd | `App.tsx`, `TerminalPane.tsx`, `terminal-paste.ts`, `BrowserWorkspace.tsx`, `GitCommitBox.tsx`, `GitDiffView.tsx` |
| Saved secrets (vault) | Electron `safeStorage` uses Keychain on macOS. On Linux without a keyring it falls back to a weak `basic_text` key, which the vault does not check for | `secure-credentials.ts` |
| Launch at login | Windows and macOS only; Linux needs an XDG autostart entry | `main.ts` `launchAtLoginAvailable` |
| Tray | Works on macOS. On Linux it needs an AppIndicator host, which GNOME lacks by default, so "close to tray" can leave no way back | `main.ts` tray code |
| Terminal links | Detects Windows paths; POSIX paths need checking | `terminal-links.ts` |
| Migration | Windows to Windows only (refuses elsewhere) | `migration-writers.ts`, `migration-archive.ts` |
| Elevation status, background CLI home | Already handle POSIX | `access-status.ts`, `runtime-core.ts` |

## Decisions needed first

1. **Which platforms and formats.** Suggested: macOS arm64 and x64 (dmg + zip) and Linux x64 (AppImage + deb).
2. **macOS signing.** An unsigned, unnotarized app is blocked by Gatekeeper, and electron-updater cannot update it.
   Shipping on macOS needs an Apple Developer account (signing + notarization secrets in CI). Linux needs none.
3. **Which goes first.** Linux is cheaper to ship (no signing); macOS probably has more users of this app.

## Plan

Each step is one PR and leaves Windows unchanged; Windows tests keep running on every PR.

### 1. CI baseline on macOS and Linux

- Add a workflow that runs `typecheck` and the unit tests on `ubuntu-latest` and `macos-latest` (Windows too).
- Mark tests that are Windows-only by nature (PowerShell helpers, `taskkill`, `mklink /J`, WinGet) as skipped elsewhere,
  with the reason. Everything else that fails is the work list for the next steps.
- Done when: the workflow is green with only justified skips.

### 2. Paths

- Replace `path.win32` with the platform's own `path` in the files listed above, keeping `win32` only where a Windows
  path is parsed on purpose.
- Add one `samePath(a, b)` helper: case-insensitive on Windows and macOS, case-sensitive on Linux. Replace the
  `toLowerCase()` folder comparisons with it.
- Make `isLocalFilesystemPath` reject POSIX network mounts only where it can tell; otherwise accept absolute paths.
- Run the path tests on every platform with POSIX and Windows fixtures.
- Done when: Git discovery, worktrees and session-store tests pass on all three platforms.

### 3. Finding programs (Copilot CLI, Git, editors)

- A shell-free `findExecutable(name)` for POSIX: walk `PATH` and check for an executable file (`X_OK`), never run a
  shell to find it.
- An app opened from Finder or a launcher gets a minimal `PATH`. Read the login shell's `PATH` once at startup
  (`$SHELL -ilc` printing `PATH`, with a timeout and no other output trusted), and fall back to adding the usual
  folders (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, the npm global bin folder).
- Git: accept a non-`.exe` binary. On macOS, `/usr/bin/git` is a stub that opens the Command Line Tools installer when
  they are missing; check `xcode-select -p` first and show a clear "install Git" message instead.
- Copilot install action: on macOS and Linux, show the install command (npm or Homebrew) instead of WinGet, or
  run `npm install -g @github/copilot` when npm is found. Update the "not found" message, which names WinGet.
- Done when: a packaged app launched from the desktop finds the CLI and Git on both platforms.

### 4. Stopping processes

- Start child processes (Git, the CLI's RPC process) in their own process group and stop the whole group
  (`process.kill(-pid)`), `SIGTERM` then `SIGKILL`. node-pty already starts the session as a group leader, so the same
  works for sessions.
- Crash cleanup: a small detached watchdog per group that kills it when the app's process disappears, matching what
  `windows-process-watchdog.ts` does on Windows.
- Done when: the lifecycle tests' "app killed abruptly" cases leave no processes behind on macOS and Linux.

### 5. Browser and meeting helpers

- The packaged app disables Electron's `RunAsNode` fuse, so the helpers cannot be Node scripts run by the app itself,
  and a standalone Copilot install may not have `node`. Write POSIX `sh` versions of `browser.ps1`,
  `browser-test.ps1` and `meeting.ps1` that use `curl` for the loopback calls (available on macOS and on mainstream
  Linux distributions; check for it and give a clear error if it is missing).
- Write the helper path and command into the instructions per platform (`"$COPILOT_DESKTOP_MEETING_HELPER" start …`
  on POSIX, the current PowerShell line on Windows), and update the reviewer and host messages that name commands.
- Keep the same rules: the token never goes on the command line or into a URL, files are read with `-File`, and the
  shared patch is filtered the same way (that filtering is in the app, not the helper).
- Done when: `meeting:check` and the browser checks pass on macOS and Linux.

### 6. Desktop behaviour

- Shortcuts: one `isPrimaryModifier(event)` (Cmd on macOS, Ctrl elsewhere) used in the six renderer files. Keep the
  terminal's Ctrl keys going to the CLI on macOS (Ctrl+C must still interrupt).
- macOS menu: an application menu first (About, Settings with Cmd+,, Hide, Quit), and keep the app running when the
  last window closes, as macOS apps do.
- Vault on Linux: check `safeStorage.getSelectedStorageBackend()` and refuse to save secrets on `basic_text`, with a
  message to install or unlock a keyring. Secrets set in the environment keep working.
- Launch at login on Linux: write and remove `~/.config/autostart/copilot-cli-desktop.desktop`.
- Tray on Linux: offer "close to tray" only when a tray icon was actually created, and fall back to quit otherwise.
- Terminal links: recognise POSIX absolute and `~/` paths.
- Migration: hide it on other platforms with a short note (cross-platform migration is a separate project).
- README: platform requirements and what differs.

### 7. Packaging and release

- `electron-builder` targets: `mac` (dmg + zip, arm64 and x64, hardened runtime, entitlements for the PTY and loopback
  server) and `linux` (AppImage + deb).
- Build node-pty for Linux on the Linux runner (it uses N-API, so compiling it once with node-gyp is enough).
- Make `audit-package` and `package-smoke` work on each platform (fuses, asar contents, version), and replace the
  Windows-only checks (Authenticode, NSIS) with signing/notarization checks on macOS.
- Release workflow: a job per platform; auto-update via `latest-mac.yml` (signed builds only) and `latest-linux.yml`
  (AppImage only; deb users update through their package manager).
- Done when: a tagged release publishes all three platforms and each installer starts, finds the CLI, opens a
  session, and the Git panel, browser and a meeting work.

## Order and size

Steps 1–4 make the core usable: sessions, Git panel and worktrees. Step 5 brings back the browser and meeting tools.
Step 6 is polish that macOS users will notice at once. Step 7 ships it. Steps 2, 3 and 4 depend on step 1's baseline
but not on each other. Step 5 needs step 3's path handling to pass its checks.
