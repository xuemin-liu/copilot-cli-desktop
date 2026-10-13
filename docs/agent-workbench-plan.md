# Agent workbench plan

Status: revision 3. Revision 1 was reworked after an independent review and revision 2 was approved with
changes, both folded in (see [Review log](#review-log)). Phases 1 (#73), 2 (#74) and 3a-0 (#75) are merged. Phase 3a is implemented on
`feat/agent-workbench-phase3a`.

Four ideas borrowed from [Orca](https://www.onorca.dev/), an open-source "agent development
environment" built around one git worktree per task, many agents in parallel, and a sidebar
that shows what each agent is doing right now. Each idea is one phase and one PR (phase 3 is
two PRs). Every phase ships on its own, keeps the app's existing rules (nothing reaches the
model without the user pressing Enter in that session; no new network surface; destructive
git actions confirm first and fail closed), and uses surfaces Copilot CLI actually exposes.

| Phase | Branch | What the user gets |
| --- | --- | --- |
| 1 | `feat/agent-workbench-phase1` | A live activity line under each sidebar session: which tool Copilot is running now, and for how long |
| 2 | `feat/agent-workbench-phase2` | Comments on diff lines in the Git panel, batched into the prompt box |
| 3a-0 | `feat/agent-workbench-phase3a0` | Fix: a fresh session with the worktree option actually starts (the CLI refuses `--worktree` with `--session-id`), and the desktop learns its id from the session store |
| 3a | `feat/agent-workbench-phase3a` | Sessions started with `--worktree` show their worktree branch, the Git panel follows them, and the Branches tab lists worktrees |
| 3b | `feat/agent-workbench-phase3b` | Remove a merged, unused worktree from the Branches tab |
| 4 | `feat/agent-workbench-phase4` | Fan-out: one prompt pasted into up to five fresh worktree sessions |

Dropped on purpose: support for other agent CLIs, an embedded editor, SSH worktrees, a mobile
companion, GPU terminal rendering. Smaller Orca ideas (terminal search, a command palette, a
usage counter in the status area, a session from a GitHub issue) are listed under [Later](#later).

## Data the phases rely on

Copilot CLI writes one `events.jsonl` per session under `~/.copilot/session-state/<uuid>/`.
The app already tails it: `SessionPermissionMonitor` (`src/main/session-permission-monitor.ts`)
streams it with bounded memory and feeds `SessionActivityTracker` (`src/main/session-activity.ts`),
which turns `assistant.turn_start` / `assistant.message` / `tool.execution_start` /
`assistant.turn_end` / `abort` into a `working` | `idle` | unknown activity. `PtySession` attaches
the monitor once the session UUID is known (`src/main/pty-session.ts`), `main.ts`
(`wireSessionEvents`) copies the activity to `DesktopSessionTab.activity`, and the sidebar
shows "Working" / "Idle".

Observed record shapes (local logs from CLI 1.0.80 to 1.0.94; fields beyond these are ignored):

```text
tool.execution_start    data.toolCallId, toolName (observed: "view", "glob", "powershell", "rg",
                        "web_fetch", "apply_patch", "rename_branch"; MCP tool names also appear),
                        arguments (tool-specific), turnId. `timestamp` is a top-level field of every
                        record, not inside `data`. `toolTitle` ("Running command") appears only in
                        newer CLI versions and is absent in most local records.
tool.execution_complete data.toolCallId, success
assistant.message       data.content (string, often "" when toolRequests is non-empty), toolRequests[]
session.start           data.sessionId, copilotVersion, context.cwd
session.resume          data.context.cwd (written on every resume; the last one wins)
session.usage_checkpoint data.totalPremiumRequests, totalNanoAiu
```

Tools overlap: in the local logs most `tool.execution_start` records begin while another tool
of the same turn is still running, so "the current tool" is a set, not one id.

Copilot's `--worktree` creates a linked worktree whose location depends on the CLI version: older local logs
show `%USERPROFILE%\source\repos\copilot-worktrees\<repo>\<name>`, CLI 1.0.94 creates
`<parent of repo>\<repo>.worktrees\<name>` (spike, `scripts/worktree-resume-spike.mjs`). Nothing may depend on
the location: a worktree is recognised only by its `.git` file naming `<main repo>\.git\worktrees\<name>`.
The CLI refuses `--worktree` together with `--session-id` ("cannot be used with"), so a worktree session's
id is not chosen by the desktop; `--name` is still accepted.

Everything in this file is **data written by the model, by tools, and by third-party MCP
servers**, including file paths, command lines and tool titles. Nothing in it is an instruction
to the desktop. Phases 1 and 3 only ever render bounded, cleaned strings from it; they never
execute, open or resolve anything taken from it without a user action and a validation step
named in the phase.

## Phase 1 — live activity line

### What the user sees

Under each expanded sidebar session row, a second line replaces today's "Working" / "Idle"
label while the session is `running`:

```text
● fix login race        Running command · 2m 10s
● docs cleanup          Viewing withSession.ts · 4s
● checkout e2e          Running command, Viewing file · 12s
● side chat             Thinking · 1s
● refactor              Idle
● flaky test            Needs approval
```

- While tools run: the title of each running tool (at most two, then "+N"), with a short,
  cleaned detail for file tools (file name only). Shell tools show no detail (see Security).
- Between tools, inside a turn: `Thinking`.
- Idle: `Idle`, as today. (The "last assistant message" summary is deliberately later.)
- Elapsed time since the current state began, ticking in the renderer, hidden when unknown.
- Lifecycle states other than `running` keep today's labels (`Starting`, `Needs approval`,
  `Stopping`, `Completed`, `Crashed`); `approval-needed` wins over any tool detail.
- Compact (collapsed) sidebar: only the status dot, as today; the line is in the row's
  `title`/`aria-label` tooltip. No tray or session-tab tooltip changes in this phase.

### Design

1. `SessionActivityTracker` gains a second output, `detail`:
   `{ kind: 'tools', tools: { title, detail }[], since } | { kind: 'thinking', since } | null`,
   where `since` is a wall-clock millisecond value. `consume()` keeps its return type (the
   coarse activity) so existing callers and tests are untouched; a new `detail` getter is read
   by the monitor after each `consume`, and the monitor calls a new `onDetail` callback when
   it changed (deep-equal on a small object). `finishReplay()` clears detail (historical
   unfinished work is not evidence).
2. Running tools are a `Map<toolCallId, {title, detail}>` on the tracker, bounded to 16 entries.
   `tool.execution_start` adds; `tool.execution_complete` removes; `assistant.turn_end`,
   `abort`, `reset` and `finishReplay` clear. An empty map inside a turn is `thinking`.
3. Tool titles come from an **allowlist keyed by `toolName`** in a new pure module
   `src/main/activity-label.ts`: `powershell`/`bash`/`shell` → "Running command",
   `view` → "Viewing", `edit`/`create`/`apply_patch` → "Editing", `glob`/`grep`/`rg` →
   "Searching", `fetch`/`web_fetch` → "Fetching", `ask_user` → "Asking you". Anything else,
   including MCP tools and whatever the CLI's own `toolTitle` says, is "Running tool". The CLI's
   `toolTitle` is not used: for MCP tools it is third-party text.
4. `since`: the record's own top-level `timestamp` is data; it is parsed, clamped to
   `[now - 24h, now]`, and `now` is used when missing or unparsable. For the `tools` state,
   `since` is the earliest start among the tools still running, so a new tool does not reset
   the clock. (The poll interval means `Date.now()` at
   consume can be up to five seconds late; the record timestamp is closer to the truth.)
5. `PtySession` exposes `activityDetail` and emits a separate `activity-detail` event.
   `main.ts` copies it to a new optional `DesktopSessionTab.activityDetail` field and routes it
   **only through `scheduleActivityBroadcast`** (the existing one-second debounce,
   `main.ts` `scheduleActivityBroadcast`), not through the immediate broadcast and Git refresh
   that the coarse `activity` event triggers. The field is runtime-only, never persisted to
   `RestoredTab`.
6. `Sidebar.tsx` renders the line; `styles.css` adds the second row; the elapsed timer is one
   `setInterval` for the whole sidebar, running only while some tab has a `since`.

### Security

- **Shell commands are never shown.** `arguments.command` and `arguments.description` are
  model-written and unbounded. Shell tools show only the allowlisted title.
- **File tools show the file name only** (last path segment of `arguments.path`), after
  stripping control characters and Unicode bidi/format characters (`\p{Cc}`, `\p{Cf}`), and
  truncating to 40 characters with an ellipsis. Full paths are already visible in the terminal.
- **Titles are allowlisted, never taken from the log**, so no third-party MCP text reaches the
  sidebar.
- **Bounded memory:** at most 16 running tools, 40-character details, computed at the tracker,
  so a malicious 8 MiB record cannot grow tab state or the IPC broadcast.
- **No new IPC channel or file access.** The data comes from the file the app already tails.

### Failure cases

- No `events.jsonl` (remote sessions, old CLI, side chats before the fork completes): no line,
  the coarse label stays as today.
- Log truncated or rewritten (`size < offset`): detail resets to null with the activity.
- Oversized record skipped: detail resets to null, diagnostic logged as today.
- `tool.execution_complete` for an unknown id, or more than 16 running tools: ignored, map
  stays bounded; the line still clears at turn end.
- Unknown tool names: "Running tool".

### Tests

- `session-activity.test.ts`: detail transitions for each event; overlapping tools (A starts,
  B starts, A completes → B still shown); turn end clears; replay/finishReplay; sub-agent
  filtering; the 16-entry bound; a U+202E in a path is stripped; unknown and MCP tool names
  map to "Running tool"; timestamp clamping.
- `session-permission-monitor.test.ts`: `onDetail` delivered after seeding, not during; cleared
  on truncation and on an oversized record (real temp files, as the existing tests do).
- `activity-label.test.ts`: formatter output for every state, "+N" overflow, elapsed rounding.
- `sidebar-render.test.tsx` (existing pattern): line shown for running tabs, hidden in compact
  mode, approval beats tool detail.
- Mutation runs: remove the bidi stripping, and remove the allowlist fallback, and show the
  tests fail.
- Electron: `node scripts/electron-side-chat-check.mjs` against the mock model, confirm the
  line appears and ticks; screenshot in the PR.

Deliberately later: idle summary from the last assistant message (a second, redaction-bearing
data path), tray and session-tab tooltips, per-tool icons, click-to-jump to the tool's output.

## Phase 2 — diff comments to the prompt

### What the user sees

In the Git panel's diff view, hovering a diff line shows a `+` gutter button. Clicking it opens
a one-line comment box under that line. Comments accumulate in a list at the bottom of the
diff ("3 comments · Add to prompt · Clear"). **Add to prompt** pastes into the active session's
prompt box, never sends:

```text
Review comments on src/checkout/validators.ts (unstaged):
1. Line 45 (`+  if (!values.country) return { ok: false, field: 'country' };`):
   return a typed error object here too
2. Line 52: add the CA test case
```

### Design

- `GitDiffView.tsx` already classifies lines (`diffLineKind`) and caps rendering at 4,000 lines
  with `diff.truncated`; it gains new/old line numbers from hunk headers (handling
  `\ No newline at end of file` markers, which carry no number), a `comments` map keyed by
  `${side}:${lineNo}`, and the gutter affordance. Lines past the render cap cannot be
  commented, and the list says so when the diff is truncated.
- `GitPanel.tsx` owns the comment state per diff key (file + staged flag). It clears comments
  when the diff key changes or the file's status entry disappears, and shows a warning (not a
  clear) when the status generation changes under open comments, since the agent may have
  edited the file.
- Formatting lives next to `composeDiffPrompt` in `src/main/git-prompt.ts` (pure, already used
  by the renderer) and **reuses its protections**: `looksSensitivePath` (no quoted lines for
  sensitive files, the comment text alone is kept), `maskSecrets` on every quoted line, and
  `fitLines` against `PROMPT_BUDGET`. If the block would exceed the budget, quoted lines are
  dropped first, then trailing comments, and the user is told how many fit. The result then
  goes through the existing `addToPrompt` path and `promptInsertText`.
- Comment text lives only in renderer state. Nothing is persisted.

### Security

- Same guarantee as the existing "Add diff to prompt": the text is pasted, the user reviews and
  presses Enter. No IPC change; the renderer already has the diff.
- Quoted lines are masked exactly like the whole-diff insert, so a comment on a `.env` line
  cannot paste a secret that the whole-diff path would have masked.
- A comment is plain text; it is never interpreted by the desktop.

### Tests

- Formatter unit tests: ordering, sensitive path drops quotes, masked secret in a quoted line,
  budget truncation order, staged vs unstaged wording.
- Hunk-header parsing including `\ No newline at end of file`.
- Render test: add, edit, remove, clear-on-key-change, warning-on-generation-change,
  truncated-diff notice.
- Mutation: break clear-on-key-change, and remove the `maskSecrets` call, and show the tests
  fail.
- Manual check in the real app with a session running the mock model.

Deliberately later: comments on history (committed) diffs, persistence across panel reopen.

## Phase 3a-0 — a worktree session starts, and the desktop learns its id

Found by the spike: for every fresh session the desktop passes `--session-id=<uuid>` (when the CLI
supports it) so that it can tail the session's event log and resume it later. The CLI refuses that
flag together with `--worktree`, so the worktree launch option has not worked with any CLI that
supports session identity. The fix:

- `finalizeSessionArgs` omits `--session-id` for a fresh worktree launch, keeps `--name`, and names the
  worktree itself: `--worktree=desktop-<title slug>-<6 hex>` (`worktreeNameFor`, git-safe, bounded,
  unique per launch). The name is what ties the launch to its session.
- `PtySession` gains store discovery: before spawning it snapshots the UUID directories under the
  session store (`copilotSessionRoot`), then polls (every 500 ms, for at most 90 s, cancelled on exit
  or stop) for a new directory whose `events.jsonl` starts with a `session.start` record whose
  `startTime` is not before the spawn and whose `context.cwd` ends in the worktree name this launch
  asked for (never the launch folder, never a record without a cwd). Two launches at once, or a session
  started elsewhere meanwhile, cannot be confused with it. The snapshot is awaited before the spawn.
  The first match becomes the session id: the same `session-id` event,
  monitor attachment, usage association and tab update as output discovery. No match leaves the tab
  as it is today for old CLIs (no monitor, `--continue` on restore).
- The record is data: only `type`, `startTime` and `context.cwd` are read, from the first 4 KiB,
  and the directory name must be a UUID.
- Tests: argument building (worktree fresh has `--name` and `--worktree` and no `--session-id`;
  resume and non-worktree launches unchanged); store discovery with real temp directories (a new
  matching directory is adopted, one whose cwd is the launch folder is skipped, a pre-existing one
  is ignored, stop cancels, timeout gives up); an Electron check mode that launches a real worktree
  session from a temp repository with the mock model and waits for the tab's session id.

## Phase 3a — worktree-aware sessions (read-only)

### Spike result

`scripts/worktree-resume-spike.mjs` (real CLI 1.0.94, mock model): a session started with
`--worktree` records the worktree as `session.start.context.cwd`, and `--resume <id>` run from the
project folder records the same worktree in `session.resume.context.cwd`: a resumed session goes
back to its worktree. The chip therefore follows the latest `session.start`/`session.resume` cwd.

### What the user sees

- The sidebar row and session tab of a session whose latest `session.start`/`session.resume`
  cwd is a linked worktree show the worktree's branch as a small chip; the tooltip shows the
  worktree path.
- The Git panel, when opened for that session, selects the worktree's repository entry instead
  of the parent repository, so the change list and commits are the session's own.
- The Branches tab lists the selected repository's linked worktrees (path, branch, `locked` /
  `prunable` flags, and the desktop session using it, if any). No actions in 3a.

### Design

- The tracker (or a small sibling parser in the same file) reads `context.cwd` from
  `session.start` and `session.resume`; the last one wins. `PtySession` emits `session-cwd`;
  `main.ts` stores it on the tab as `sessionCwd` (runtime-only; on restore it is re-read when
  the monitor seeds).
- `sessionCwd` is validated before use: `isLocalFilesystemPath` (as `discoverRepos` does),
  then `realpath`, then its `.git` **file** must contain a `gitdir:` that resolves, after
  `realpath`, to `<repo>/.git/worktrees/<name>` for a repository already discovered under the
  profile folder. Anything else is ignored and the tab shows nothing.
- `git-discovery.ts` reports such a worktree as a repo with a new `GitRepoKind` `'worktree'`
  and `worktreeOf: <main repo id>`; IPC validation and `RepoRow` learn the kind. The entry's
  `.git` file goes through `inspectGitEntry` (commondir and alternates checks), not a bare
  `gitdir:` match.
- **Late arrival:** `sessionCwd` usually arrives after the panel is open and discovery has run.
  `main.ts` passes it to the Git service, which validates it as above, adds the repo to the
  profile's discovery result, and pushes `onGitChanged` so the open panel re-renders and can
  select it. When a worktree folder disappears (phase 3b removal, or the user deleting it), the
  service drops the entry on the next status poll instead of polling a deleted folder.
- `git-commands.ts` adds `worktree list --porcelain` (read-only), parsed in `git-parse.ts`.
- **Trust:** trust and hook approval are keyed by canonical path. A worktree's config is the
  main repo's config plus the worktree's own `config.worktree` file, and its hooks are the
  shared `.git/hooks`. The worktree inherits the main repo's trust and hook decisions only
  after the same program-running-config scan is run over `config.worktree`; a hit asks for
  review as the main repo would. A `gitdir` that escapes the main repo is refused.

### Tests

- Discovery tests with a real linked worktree fixture, a `gitdir` pointing outside, a
  `sessionCwd` that is a junction, a UNC `sessionCwd`, and a `sessionCwd` outside any
  discovered repo.
- Parser tests for `worktree list --porcelain` including `locked`, `prunable`, `detached`.
- Tracker tests: `session.resume` cwd overrides `session.start`.
- Render test for the chip and the Branches tab section.
- Electron: the existing git IPC check script extended with a worktree.

## Phase 3b — remove a worktree

### What the user sees

In the worktree list, **Remove** on a worktree whose branch is merged into the repository's
default branch. A native confirmation names the path and states plainly that **ignored files
in that folder (build output, `node_modules`, local `.env` files) are deleted too**. Removal
uses `git worktree remove` without `--force`; git refuses a dirty tree and the panel shows
the reason.

### Design and safety (fail closed)

- Refused, with the reason shown, when: the worktree is the main worktree; it is `locked` or
  `prunable`; the branch is not merged (`git branch --merged <default>`, default from
  `origin/HEAD`, else `main`, else `master`, never by name alone); **any** session in the
  profile whose status is anything other than `completed` or `crashed` (so `starting`,
  `running`, `approval-needed` and `stopping` all count) has a `sessionCwd` that is this
  worktree **or unknown** (remote sessions and old CLIs have no cwd, so they block removal);
  the tree is dirty.
- The checks run before the dialog and again inside `runWithLockWait` on every attempt,
  exactly as `changeBranch` does, because the dialog can stay open for a long time.
- Nothing is snapshotted: the whole point is to delete the folder, and git already refuses
  when tracked changes exist. Ignored-file loss is stated in the dialog instead.

### Tests

- Service tests for list, merged computation, remove (clean), and each refusal (dirty, in use,
  unknown cwd with a running session, main, locked, prunable, unmerged).
- Re-check inside the lock wait: state changes between the dialog and the attempt are refused.
- Electron: remove a worktree through the real dialog path in the git IPC check.

Deliberately later: creating worktrees from the panel (Copilot does this itself), pruning
stale entries, worktrees of submodules, "already checked out in a worktree" wording in
`describeSwitchFailure`.

## Phase 4 — fan-out

### What the user sees

A new **Fan out…** action beside **New session with attachments…** opens a small renderer
dialog (there is no new-session dialog today: creation goes straight to a native file picker)
with a prompt field and **Run in N parallel sessions** (2–5). Each session starts fresh,
in its own worktree (the dialog forces the worktree launch flag on for these sessions), with
the typed prompt **pasted** into its prompt box. The user presses Enter in each session. The
sidebar shows a shared label ("fan-out · fix login race") on the rows while the app runs; the
Git panel's worktree list (phase 3a) lets the user compare and keep one.

### Design

- `createSessionTab` in `main.ts` gains an optional launch override (`{ worktree: true }`)
  so the profile's launch config is not changed; `buildSessionLaunchArgs` is unchanged. The
  only new tab data is a runtime-only `fanOutLabel` (not persisted; after a restart the
  sessions are ordinary worktree sessions with chips).
- Sessions are created **sequentially**, each after the previous one's `session.start` cwd is
  known, because five concurrent `git worktree add` on one repository contend for the same
  locks. If a cwd does not arrive within the timeout, the fan-out **stops** and reports how
  many sessions were started; it never starts the next one blind.
- The prompt is pasted through `insertIntoPrompt`, bounded as always. There is no "send to
  all": one click submitting to five sessions would weaken the house rule.
- Capped at 5 and at the remaining tab budget (20 minus open tabs). The dialog shows the
  premium-request warning once.

### Tests

- Launch-argument tests (worktree forced on, N capped, budget respected).
- Sequential creation test (second spawn waits for the first cwd or timeout).
- Render test for the label.
- Electron: start three mock-model sessions, confirm three worktrees and three pasted prompts,
  none submitted.

Deliberately later: automatic comparison or scoring of results, merging the winner from the
panel (phase 3's worktree list plus the existing branch switch covers the manual path),
persisting the group across restarts.

## Later

Each is a small, independent PR, not part of the phases above:

- Idle summary from the last final assistant message (first line, redacted with
  `redactDiagnosticText`, bounded), plus tray and session-tab tooltips.
- Terminal search (`@xterm/addon-search`, Ctrl+F in the terminal pane).
- Command palette (Ctrl+K over sessions, workspaces, and existing actions).
- Compact usage counter in the status area, fed by `session.usage_checkpoint` events.
- New session from a GitHub issue URL (`gh issue view --json`, prompt pre-filled, never sent).

## Review log

- Revision 1: draft.
- Phase 2 result: shipped as designed, with one change: comments are keyed by file path and side, not by the
  panel's diff key, because entry ids change with every status generation and the key would have cleared the
  comments each time the agent touched any file. Staleness is detected by comparing the diff text the comments
  were written against, not the status generation, which also advances on refreshes that change nothing.
  Review of the PR added: redaction of a quote inside a private-key block is decided when the comment is
  captured, from the diff current at that moment (a shared snapshot would mismatch later comments), and every
  bucket of the repository is reconciled against each complete status so comments on a reverted change never
  come back; hunk content is classified by first character while the hunk header counts last, so +++ and ---
  content lines are not taken for file headers.
- Phase 1 result: shipped as designed. The `--activity` Electron check now also makes the mock
  model call the real CLI's `view` tool and replays the recorded `tool.execution_start` through
  the tracker, so the label contract ("Viewing marker.txt") is checked against the installed
  CLI on every run. The CLI offers `view`, `ask_user`, `grep` and `glob` to a BYOK model in
  the read-only preset; tool execution itself is too brief to observe through the one-second
  broadcast debounce, which is by design.
- Phase 3a review (independent): a forged `.git` file under the accepted repository's `worktrees` directory
  with a `commondir` naming another repository passed; an older cwd inspection could overwrite a newer one
  for the same tab; the chip never followed a branch switch or rename; and two new tests compared short and
  long forms of a temp path on CI. Fixed by requiring `commondir` to be the accepted repository's `.git` and
  the backpointer to name the worktree's `.git` file, a per-tab generation for cwd events, a five-second
  HEAD poll for worktree tabs, and canonical fixture paths.
- Phase 3a result: shipped as designed, with these decisions. The session folder is read from
  `session.start`/`session.resume` by the activity tracker and published by the monitor (after seeding,
  history being the truth about where a session runs). A worktree is recognised only by
  `inspectSessionWorktree` (filesystem only): `.git` must be a file whose `gitdir` resolves, after links,
  to `<repo>\.git\worktrees\<name>`, and `<repo>` must be accepted by the caller (main process: inside
  the workspace folder; Git service: one of the discovered non-parent repositories). The service lists
  session worktrees on every refresh from a pull callback (`sessionWorktrees(profileId)`), on top of the
  cached discovery, so they appear when a session reports one and drop out when it closes or the folder is
  gone. Trust is not inherited: a worktree is reviewed on its own, like any repository (the plan's
  inheritance idea was dropped as the riskier option). The parent repository above the workspace is not
  followed. The Branches tab's worktree list is read-only; removal is phase 3b.
- Phase 3a-0 review (independent): discovery by "any new session outside the launch folder" could adopt
  another launch's or another project's session, the pre-spawn snapshot was started but not awaited, and
  the spike's synchronous spawn starved its own mock server. Fixed by naming the worktree per launch and
  matching the record's cwd to it, awaiting `ready()` before the spawn, and spawning the spike's CLI
  asynchronously with exit codes asserted.
- Phase 3a-0 result: shipped as designed, plus one more pre-existing defect found by the real-app check: a
  tab created right after launch was validated against empty capabilities while the startup probe was
  still running, and refused for an option the CLI supports. The spawn plan now waits for an in-flight
  probe. The real-app check (`--worktree` mode) starts a fresh worktree session from a temporary
  repository with CLI 1.0.96, which creates `<workspace>.worktrees\<name>`.
- Phase 3a spike: `--resume` returns to the worktree (CLI 1.0.94); worktrees live at
  `<repo>.worktrees\<name>` in 1.0.94 and elsewhere in older versions; and `--worktree` cannot be
  combined with `--session-id`, which the desktop passes for every fresh session, so the worktree
  launch option was broken. Phase 3a-0 was added for that fix, before 3a.
- Revision 3: the same reviewer approved revision 2 with changes, all applied: 3b's removal
  gate counts every status except `completed`/`crashed`; `timestamp` is top-level; the tool
  allowlist uses the names actually observed (`rg`, `apply_patch`, `web_fetch`); `since` for
  running tools is the earliest start; phase 4 names the new dialog and the launch override;
  3a specifies the late-arrival path through the Git service and `inspectGitEntry`, and
  dropping removed worktrees; the fan-out timeout stops instead of continuing; hook approval
  inherits with trust.
- Revision 2: independent review (fresh subagent) found: the tray and session-tab tooltips
  named in phase 1 do not exist; tools overlap so the tracker must hold a set; `toolTitle` is
  absent in most logs and is third-party text for MCP tools, so titles are now allowlisted by
  `toolName`; file names need bidi stripping; the coarse activity event triggers an immediate
  broadcast and Git refresh, so detail now goes through the one-second debounce; phase 2
  must reuse `maskSecrets` / `looksSensitivePath` / `fitLines` and note the 4,000-line cap;
  `session.resume` also carries cwd; Copilot's worktree location is known; `sessionCwd` needs
  `isLocalFilesystemPath` before `realpath`; trust is keyed by canonical path; worktree
  removal must fail closed on unknown cwd, refuse locked/prunable, re-check inside the lock
  wait, and state that ignored files are deleted; the restore behavior of `--resume` for a
  worktree session needs a spike; "Send to all" was dropped; fan-out grouping is runtime-only
  and creation is sequential. Phase 3 was split into 3a (read-only) and 3b (remove), and the
  idle summary moved to Later.
