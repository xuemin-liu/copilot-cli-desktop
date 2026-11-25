# Plan: turn checkpoints and large-paste attachments

Status: agreed in review meeting BK97 (2026-11-25; reviewers: Antigravity and Codex). A1 and A2 are built and merged (PRs 315 and
316). B1 is not built and will not be: Copilot CLI already saves a large paste as a file itself. See the revision
notes at the end.

Both ideas come from T3 Code's documentation (MIT licensed). Only its docs were read, not its source, so
the designs below are our own. The designs rest on reading our code and Git's documentation; no prototype
has been run. Each phase lists what it must prove.

## Part A: turn checkpoints

### Goal

For each prompt a person sends in a Copilot session, the Git panel shows the changes observed during that
turn. The person's repository is never written to: no refs, no objects, no index changes.

Restoring files to an earlier checkpoint is **not planned** (see "Restore" below).

### Store

1. A self-contained shadow Git directory for each worktree, under `<userData>/checkpoints/`. It has no
   alternates and no copy of the project's index.
2. Commands run through `GitRunner` with validated absolute `GIT_DIR` (the shadow) and `GIT_WORK_TREE`
   (the session's worktree) in `environment.extra`, and `disableHooks` on writes.
3. Checkpoint commits have no parent, and the message is only `checkpoint <n>`. The project's `HEAD` and
   branch, and the prompt's label, are kept in app-data metadata, never in Git objects.

### Which paths are captured

4. The project decides, on every capture. A bounded read on the project side lists tracked paths and
   untracked paths that are not ignored. That read goes through the existing trust gate
   (`inspectGitEntry`, `inspectSessionWorktree`, the `passGate` rules).
5. The shadow stages exactly that validated list, and removes entries that are no longer on it. The
   shadow never runs an unrestricted `git add -A`.
6. Left out, and listed as "not captured": submodules and embedded repositories, links, paths behind a
   junction, and files over the per-file limit.
7. No checkpoint at all, with the reason shown: a sparse checkout, a "parent" repository, an untrusted
   repository, a Git older than 2.32, or a capture over the byte budget (including the first one).

### Conversion

8. The shadow uses isolated config: `GIT_CONFIG_NOSYSTEM=1` and an app-owned empty global config file.
9. The shadow's `info/attributes` turns off text, end-of-line, filter, ident and working-tree-encoding
   conversion. No filter program runs, and a checkpoint holds the bytes that are on disk.
10. The Turns diff therefore promises "the files as they are on disk". A1 must prove this with tests
    (CRLF files, a filter attribute, a Git LFS setup). If it cannot be proven, paths with a filter
    attribute are left out instead.

### Turn boundaries

11. A turn ends when the session becomes idle (final response, error, or abort). Raw
    `assistant.turn_end` is not used: it fires after every model call.
12. A turn starts at the live prompt, before the early return for Desktop and meeting prompts in
    `main.ts`. Where Desktop owns the submission (`sendSessionTask`), the capture is taken before the
    paste. Replayed history is excluded.
13. Captures are queued for each worktree.
14. A turn is marked incomplete, with no diff, when its end capture is missing (quit or crash), when
    another prompt started before its end capture was taken, or when a Desktop capture missed its
    pre-send deadline.

### Turns list (Git panel)

15. Every diff is labelled "changes observed during this turn". It can include edits from an editor or
    another session.
16. External diff programs and textconv are off.
17. A missing object shows "checkpoint no longer available" for that turn only.

### Space

18. Startup prune by age, by a turn cap for each repository, and by whether the session still exists in
    `copilotSessionRoot`. (There is no "delete session" action to hook.)
19. After pruning, space is really reclaimed (gc, or repack and prune) inside the shadow only,
    serialized with capture and read, under a total byte cap. Tests measure the disk space reclaimed.
20. Nothing is ever collected in the person's repository.
21. The off setting, pruning and limits ship in the first capture PR.

### Restore (not planned)

Copilot's conversation cannot be rewound, so after a restore it would still believe its edits exist, and
restore carries almost all of the data-loss risk. If it is revisited: only the selected paths of one
turn, each rechecked at apply time, a byte backup completed before the first write, submodule paths
refused.

### Phases (one PR each)

- **A1 Capture.** The shadow store, path selection, boundaries, the off setting, pruning and limits. No
  UI. Tests use real temporary repositories and must show: the project's index, `HEAD`, refs and objects
  are unchanged; a file that becomes ignored drops out of the next capture; a force-added ignored file
  comes in; an unborn `HEAD`, a split index and a SHA-256 repository all work; the conversion claim in
  item 10 holds.
- **A2 Turns list and diff.** The list in the Git panel, with the label, the incomplete state and the
  "no longer available" state.

## Part B: large paste becomes a file

**Not built.** The gate below was answered "no-go" once the real app was tried: see "B0, corrected" in the revision
notes. The section is kept as the record of what was agreed.

### Goal

A large paste into a local Copilot session's prompt is saved as a text file, and a reference to the file
is put in the prompt. The prompt stays small and nothing is sent until the person presses Enter.

### B0: spike, a go/no-go gate

Run first. It answers:

- Does Copilot CLI already collapse a large paste itself? (`PASTE_PLACEHOLDER` in `meeting-turns.ts`
  suggests it does, which may make B1 unnecessary.)
- Does `@<path>` work with spaces and non-ASCII characters in the path?
- Can Copilot read a file outside the working folder under the default, trusted-directory and read-only
  presets without asking for permission?

### B1: the feature, only if B0 says go

1. Files go in `<userData>/paste-attachments/<sessionId>/`. Never the project, and never the session
   helper folder (it holds loopback tokens and is passed to Copilot as an instructions folder).
2. Local Copilot sessions only. Remote sessions, other CLIs' tabs and plain terminals keep today's
   behaviour. Eligibility reaches `TerminalPane` as props, because the paste handler must decide at once.
3. Threshold: 32 KiB of UTF-8, provisional until B0.
4. The whole text is saved, up to 10 MiB a paste and a cap for each session.
5. Raw paste (Ctrl+Shift+V, Cmd+Shift+V on macOS) is an intent armed on the key gesture, tested on
   Windows, Linux and macOS. Menu paste is tested separately.
6. A dismissible notice offers **Paste as text instead**.
7. On a quota or write failure nothing is inserted automatically. The failure is reported, the clipboard
   and the draft are untouched, and a bounded raw paste is offered with its truncation stated.
8. After any asynchronous step the originating pane and prompt are checked again before anything is
   inserted.
9. Cleanup by age and by the session cap. Files that were never delivered are removed.

## Order

B0, then A1, then A2. B1 only if B0 says go.

## Revision notes

### B0 spike (2026-11-25, Copilot CLI 1.0.114): go (later corrected to no-go, see below)

Run with real `copilot -p` prompts against a 49 KB file in a folder whose name has a space and a non-ASCII letter.

- `@"<path>"` works with spaces and non-ASCII characters.
- Copilot does not load the file into the prompt. It reads it on demand: it first reports "too large, not read", then
  reads ranges or searches it. So a file reference does keep the prompt small.
- A file outside the working folder needs an approval ("read path"), and with no person to answer it is denied.
- With `--add-dir <folder>` at launch the file is read without asking, under the default preset and under the
  read-only preset (`--available-tools=view,glob,grep,ask_user`).
- Not verified: what the interactive prompt does with a large paste. The stand-alone test could not get the CLI to
  accept input. `meeting-turns.ts` notes that only older CLIs recorded a paste as a placeholder, so current ones
  record the full text.

Consequence for B1: the paste folder has to be passed with `--add-dir` when the session starts, or the first read of
each pasted file asks for approval.

### A1 as built

- Modules: `checkpoint-store.ts` (the shadow store, path selection, pruning), `turn-checkpoints.ts` (turn boundaries),
  `turn-checkpoint-target.ts` (which repository, and the trust gate). Setting: `turnCheckpoints`, on by default.
- Limits: 25 MB a file, 500 MB and 60,000 files a snapshot, 120 s a capture, 50 turns a session, 200 turns a
  worktree, 30 days, 1 GiB a store.
- Proven by tests: the project's index, `HEAD`, refs, objects, config, status and stash are unchanged by a capture;
  CRLF bytes are kept under `* text=auto`; a filter program in the global config does not run; a file that becomes
  ignored drops out and a force-added one comes in; unborn `HEAD`, a split index and a SHA-256 repository work; a
  prune gives disk space back.
- Different from the agreed text: a task the desktop sends starts its turn just before the paste, but the send is
  never held back for the snapshot, so there is no "missed its pre-send deadline" state (item 14). A snapshot that
  is still running when the agent starts editing can include those edits; the Turns list will label every diff
  "changes observed during this turn".
- The trust gate needs the Git panel's own answer: a repository whose settings need review gets no snapshot until
  the person accepts them in the Git panel.

### A1 after review (PR 315)

- The trust gate is asked inside the store's queue right before each snapshot, the end one too, instead of once when
  the turn starts.
- An end snapshot can be discarded until it is saved, not only while it waits in the queue.
- The turn caps are enforced after every turn, and space is reclaimed once ten turns have ended or been dropped;
  the full prune repeats every six hours.
- Turning the feature off cancels open turns, and deleting the snapshots needs no Git.
- Unloading or restarting a tab, and a switch to another conversation, close the open turn as incomplete.

### A2 as built

- The Git panel has a **Turns** tab between Changes and History. It lists up to 200 turns of the repository, newest
  first, over all its sessions. A complete turn opens to its changed files (`diff-tree` between its two snapshots,
  run inside the store) and each file to its patch, in the panel's existing diff view.
- Every diff is labelled "Changes observed during this turn". An open turn, an incomplete turn (with its reason), a
  turn with no changes, paths left out of the snapshot and a checkpoint that is no longer available each have their
  own text.
- The tab reads the store only. It never runs Git in the project, so it needs no trust check of its own.
- User documentation: [Turns in the Git panel](git-panel.md#turns).

### B0, corrected: no-go, and B1 is dropped

The spike left one question open: what the interactive prompt does with a large paste. The answer came from building
B1 and running it in the real app with the real CLI (1.0.114) and the local mock model.

- A 40 KB paste typed into the prompt as it is (Shift with the paste key, so B1's own handling was bypassed) was
  recorded by Copilot as
  `<pasted_content file="…/session-state/<session id>/files/paste-<number>.txt" size="40.2 KB" lines="703" />`.
  The message sent to the model carried the same reference and none of the pasted text.
- So Copilot CLI already does what B1 set out to do: it saves a large paste as a file in its own session folder and
  puts a reference in the prompt.
- Not verified, so do not rely on it for sensitive text: whether the model can read that file without an approval
  (the mock model was not asked to read it; the only file read in this run was of the B1 prototype's own file, with
  `--add-dir`), and how long the file is kept (no session was deleted and the file was not looked at again, so
  which action, if any, removes it is unknown). The file sits under Copilot's `session-state` folder in plain text.
- The note in `meeting-turns.ts` that "older CLIs recorded a large paste as a placeholder" does not mean that current
  ones send the full text, as the first spike report assumed. That assumption was wrong.
- Not measured: the size at which Copilot starts doing this. 40 KB is over it.

B1 worked in that run (a 40 KB paste was saved whole, the prompt named the file, and the session read it without an
approval because its folder was passed with `--add-dir`), but it would only duplicate the CLI's own behaviour with a
second folder, a second set of limits and an extra launch argument. It was not opened as a pull request.

What remains true in Desktop: a paste over 1,000,000 characters is cut at that length before it reaches the terminal
(`terminal-paste.ts`), without a notice. That is a separate, smaller matter and is not changed here.

Found on the way, not fixed here: `scripts/check-clipboard.mjs` calls `clipboard.availableFormats()`, which the
installed Electron (45.3.2) does not have, so `npm run paste:check` fails at its native-paste step on this machine
before it tests anything.
