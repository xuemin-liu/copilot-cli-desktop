# Git panel: phase 0 spike results

Measured on Windows 11, Git for Windows 2.55.0 (`C:\Program Files\Git\mingw64\bin\git.exe`), Node 24.14,
Electron from `node_modules`. These settle the open items in [git-panel-plan.md](git-panel-plan.md#spikes).
The hardening cases are repeatable tests in `src/main/git-hardening.test.ts`. The rest were one-off scripts that are
not kept in the repository; the setup of each is described so it can be repeated.

## 1. Shortcut delivery — decided by design, to be proven in phase 1

Not measured end to end: it needs the toggle and a running session, which phase 1 builds.

What the code shows:

- The main window already uses menu accelerators for app commands (`CmdOrCtrl+T`, `CmdOrCtrl+Shift+R`, …).
  The renderer's own handler is bubble-phase and xterm's custom key handler returns `true` for most keys,
  so a renderer-only handler for `Ctrl+Shift+G` could be consumed by the terminal.
- `before-input-event` is already used for the browser view (`browser-debug.ts`). It runs in the main process
  **before** the page sees the key, so it is independent of xterm.

Decision: handle the shortcut with `before-input-event` on the main window's `webContents`, forward the same
key from the native browser view, and call `preventDefault()` so xterm never sends `^G` to Copilot.

**Collision found:** the browser view already treats `Ctrl+G` / `Ctrl+Shift+G` as find next / previous while a
find is active. Inside the browser view, find wins while a search is open; otherwise the key toggles the panel.
If that proves confusing, switch to a different chord (the plan only needs one).

Phase 1's Electron check must press the shortcut with the terminal focused and with the browser view focused.

## 2. `GIT_CEILING_DIRECTORIES` on Windows — works as needed

| Ceiling value (project = `outer\sub\project`, repo at `outer`) | `rev-parse --show-toplevel` |
| --- | --- |
| none | `outer` |
| `outer\sub` (the project's parent) | not a repository |
| `outer` (the repo itself) | not a repository |
| `outer\sub` with forward slashes or a trailing `\` | not a repository |
| `outer\sub\project` (the working folder itself) | `outer` (ignored) |

Behavior to rely on:

- A ceiling on a proper ancestor stops discovery at that folder, and the ceiling folder itself is not checked.
- A ceiling equal to the working folder has no effect.
- Backslashes, forward slashes and a trailing separator all work.

Consequence for discovery: to see whether the project sits **inside** a larger repo, run once with no ceiling and
apply the guard (drive root, home directory); to scan only within the project, set the ceiling to the project's
parent (`ceilingDirectories()` in `git-env.ts`).

## 3. Credential prompts — fail fast, no UI

`git ls-remote https://github.com/<nonexistent>/<repo>.git` with the hardened environment
(`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`) on a machine with Git Credential Manager as the helper:

- exit 128 in about 0.5 s, `fatal: could not read Username for 'https://github.com': terminal prompts disabled`;
- no Git Credential Manager window, no hang.

Not tested: SSH remotes (`GIT_SSH_COMMAND` batch mode is provided in `git-env.ts` but is only valid after
`core.sshCommand` is checked), or a host that requires a stored credential that has expired.

## 4. `shell.trashItem` on junctions and streams — safe

Electron, temp folders only:

- `fs.lstat` on a junction reports `isSymbolicLink() === true` (Node 24), so one `lstat` check catches junctions
  and symlinks.
- `shell.trashItem(<junction>)` removes **only the link**; the target folder's files were untouched.
- `shell.trashItem('file.txt:stream')` is rejected (`Failed to parse path`); the file itself was untouched.

The plan's rules stay as written (`lstat` first, reject links, contain with `realpath.native`), because
`trashItem` itself is safe but a path computed from repo data still must be checked before the call.

## 5. `status` timing — about 1 s at 20,000 files

Fixture: 20,000 tracked files in 200 folders, `core.autocrlf=true`, 20 modified and 1 untracked.

| Command | Time (3 runs) |
| --- | --- |
| plain `git status --porcelain=v2 -z --branch` | 0.96–1.10 s |
| hardened (`statusArgs()` through the runner) | 1.00–1.11 s |

- The hardening flags cost nothing measurable.
- One status per second of CPU at this size is why the plan uses event-driven refresh, adaptive spacing
  (`max(interval, 3 × lastDuration)`) and no polling while the panel is closed.
- With `autocrlf=true`, git wrote an LF/CRLF warning **per file** on `add` (over 1 MB of stderr for 20,000 files).
  The runner caps stderr at 64 KB and decides success from the exit code, which the tests cover.
- Building the fixture took 3.5 minutes because of those warnings; do not use a 20,000-file fixture in CI.
  The measured numbers are recorded here instead, and a smaller fixture can guard the cap logic.

## 6. Which flags change output — none that the parsers need

`parseStatusV2`, `parseNumstat`, `parseLog` and `boundText` have unit tests with literal output. The real-output
path is covered by the runner tests and by the status parse in the large-repo script (21 entries parsed from 20
modified + 1 untracked, no malformed records, branch fields correct).

## 7. Hardening: what a flag can and cannot stop

For each case the test first proves that **plain git does run the configured program** (a marker file appears),
then that the hardened runner does not.

| Repository setting | Plain git | Hardened runner |
| --- | --- | --- |
| `core.fsmonitor` command, on `status` | runs | blocked (`-c core.fsmonitor=false`) |
| `diff.<driver>.textconv`, on `diff` | runs | blocked (`--no-textconv`) |
| `diff.external`, on `diff` | runs | blocked (`--no-ext-diff`) |
| `gpg.program` via `log.showSignature`, on `log` | runs | blocked (`--no-show-signature`, `-c log.showSignature=false`) |
| `filter.<name>.clean`, on `status` | runs | **still runs** |

The clean-filter case is expected: no command-line flag disables attribute-driven filters, and a repository can
make `status` run one by making a file look modified. This is why the repo trust gate is required and not an
extra: a local `filter.*` setting must put the repository in "Needs review" before anything but a config read
touches it. The test `a config that only the trust gate can see…` shows that the local config read the gate
uses (`git config --local --show-origin -z --get-regexp …`) lists those settings without running anything.

## 8. Other findings that changed the plan

- **Planted `git.exe` control did not reproduce.** A bare `spawn('git')` with the working folder containing a copy
  of `node.exe` named `git.exe` still ran the real git on this machine (Node 24, Windows 11). The runner never
  spawns a bare name anyway, and `git-runner.test.ts` keeps the regression test, which asserts the real git
  answers.
- **Kill ordering.** An early runner version resolved as soon as the child exited, before `taskkill /T` had finished,
  so a hook's child process could still hold the folder open. The runner now resolves only after the tree kill
  completes (bounded at 6 s). An abort costs roughly 1–1.5 s because of `taskkill`.
- **Windows file names.** `*`, `?` and `:` cannot be file names, so literal-pathspec tests use bracket names
  (`[a].ts`), which git would otherwise treat as a glob.
- **Which git.** `where.exe git` returned `mingw64\bin\git.exe`; the `cmd\git.exe` shim is a different process. Both
  are handled because the tree kill is recursive.

## Minimum git version

`2.30.0`, set in `MIN_GIT_VERSION` (`git-parse.ts`). Features used: `status --porcelain=v2` (2.11),
`--no-optional-locks` (2.15), `--literal-pathspecs`, `--pathspec-from-file` / `--pathspec-file-nul` (2.25),
`--end-of-options` (2.24), `--no-show-signature` (2.10). `GIT_NO_LAZY_FETCH` (2.44) is set harmlessly and ignored by
older versions. The supported floor is a policy choice, not a measured limit; only 2.55 was run here.
