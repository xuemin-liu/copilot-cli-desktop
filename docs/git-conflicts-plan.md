# Plan: when Pull fails, let the session's Copilot pull and resolve the conflicts

Status: phase 1 built (user docs: "Resolve with Copilot" in [git-panel.md](git-panel.md)); phase 2 not started. Extends [git-panel-plan.md](git-panel-plan.md), which lists "merge/rebase UI, conflict
resolution" as non-goals; this plan does not add either to the panel. Copilot does the merge, as it already does when asked in
the terminal.

## The workflow this is for

1. Open the Git panel. It lists the main repository and its worktrees; select the main one.
2. Click **Pull**. It fails: the branches have diverged, or local changes are in the way, or the merge would conflict.
3. Today the only option is to go to the terminal and ask Copilot "pull and resolve the conflicts", which works well.

The goal is to skip step 3. The failed pull offers **Resolve with Copilot**, which gives that same task to the AI of the active
session.

## Where we are

- **Pull** is `fetch` then `merge --ff-only <upstream ref>` (`git-service.ts`, `sync('pull')`). `describeSyncFailure`
  (`git-sync.ts`) turns a failure into a `reason` and a message: `diverged` ("Merge or rebase in a terminal"), `auth-required`,
  or a generic `failed` with Git's first line, for example "Your local changes to the following files would be overwritten".
- **The panel can already reach the session:** `promptTarget` (the active session in this window) and `insertIntoPrompt`, used
  by **Add to prompt** and **Draft commit message**, paste text without sending it.
- **Main can already type and press Enter safely:** `sendSessionRename` (`main.ts`) types into a session only when it is
  running, idle, its prompt box is empty and quiet, and it holds back keys pressed meanwhile. The same gate can send a prompt.
- **The panel refreshes when a session's activity changes,** so it will show the result after Copilot's turn without new code.

## Phase 1: Resolve with Copilot on a failed pull

### When the button appears

Under the pull result, for these failures only:

| Failure | How it is detected |
| --- | --- |
| `diverged` | existing `CANNOT_FAST_FORWARD` match |
| `local-changes` (new reason) | Git's "Your local changes … would be overwritten by merge" / "untracked working tree files would be overwritten" |
| Conflicts already in the repository | status has unmerged entries (a merge started elsewhere stopped on conflicts) |

Never for `auth-required`, `no-remote`, `cancelled`, a timeout or a stale branch: Copilot cannot fix those, or they need the
person.

### Which session does it

- **The active session in this window** (`promptTarget`), the one whose AI the person uses. Its model is whatever that session runs.
- **Disabled, with the reason, when:**
  - there is no session in this window, or it is popped out;
  - the session runs **Read-only** (`read-only` preset), so it cannot edit or run Git;
  - the session is not running.
- **The folder is named explicitly.** The selected repository (often the main worktree) may not be the session's own folder: a
  worktree session runs in `<repo>.worktrees\<name>`. The prompt gives the absolute path, and the button's tooltip says when it
  is outside the session's folder ("Copilot works in D:\…\repo, outside its own folder, and may ask for permission").

### What is sent

Built in `git-prompt.ts` next to the other prompt builders, under the same 11,000-character limit and redaction:

- the repository path, branch, its upstream (`origin/main`), and ahead/behind counts;
- the failure message and the last lines of Git's output (redacted like every other result);
- if local changes blocked it, the list of those files;
- the task:
  - pull the upstream into this branch with a **merge** (no rebase, no `--force`, no `reset --hard`, no push);
  - resolve every conflict, keeping the intent of both sides, and leave no conflict markers;
  - **if uncommitted changes block the pull, stop and ask** before stashing or committing them;
  - run the project's quick checks (type check, tests) if it has them;
  - commit the merge with Git's default message, and finish with a short note per conflicted file saying what was kept.

### How it reaches the session

- **Sent when it is safe to send:** session idle, prompt box empty, no key pressed just now, the same gate as `sendSessionRename`,
  moved into a shared helper. The click on **Resolve with Copilot** is the person's request, and the text is fixed by the panel,
  not by them, so sending it is what they asked for.
- **Otherwise pasted, not sent**, with the notice "Copilot is busy. The task is in the prompt box of "{title}"; press Enter when it
  is ready." A busy session is never interrupted and a draft is never sent with the task attached.
- A new IPC, `desktop:session-send-task` `{ tabId, text }`, returning `sent | busy | refused`; on `busy` the renderer pastes. The
  renderer never writes Enter itself. Main sends the task as one bracketed paste, so it does so only when the CLI has bracketed
  paste on (tracked from its output); otherwise the task is pasted, which joins lines safely.
- The target is always the active session in this window, so it is already in front: the person sees Copilot working and any
  permission prompts it raises.

### While and after Copilot works

- The pull result is replaced by "Copilot is resolving the pull in "{title}"…", with a link to the session.
- The panel's write buttons for that repository (Pull, Push, Commit, stage, switch, discard) are disabled while that session is
  working, so the panel and Copilot never write to the same repository at once.
- When the session goes idle, the panel refreshes as it already does and shows the outcome: merged (`↑N` to push), conflicts
  still present (the Conflicted list), or nothing changed. **Push stays a separate click.**

## Phase 2 (optional): reviewing what Copilot chose

Only if phase 1 shows it is needed:

- A merge-in-progress banner (from `MERGE_HEAD`) with **Abort merge** (`git merge --abort`, native confirmation).
- The **✓** for a conflicted file refuses while conflict markers remain.
- A **Review merge** view that diffs the merge commit against each parent, so the person sees what was taken from each side.

## Risks

| Risk | Handling |
| --- | --- |
| Copilot drops one side's change | It must report per file; phase 2 adds a merge review view |
| Copilot stashes or discards local work | Told to stop and ask; never asked to stash, reset or force |
| The task lands in the wrong checkout | Absolute path in the prompt; tooltip when it is outside the session's folder |
| Typing into a session the person is using | Same idle, empty, quiet gate as `/rename`; otherwise paste only |
| Panel and Copilot write at the same time | Panel writes disabled for that repository while the session works |
| Secrets in Git output | Existing redaction of output and remote addresses |

## Tests

- `git-sync.test.ts`: the new `local-changes` reason (merge and untracked-file variants), and that auth or stale failures offer no
  button.
- `git-prompt.test.ts`: the resolve prompt (path, branch, upstream, blocked files, budget, redaction).
- `main-lifecycle.test.ts`: the shared send helper. It sends when idle and empty; pastes when busy, when there is a draft, or a
  key was just pressed; holds keys pressed during the send.
- `git-panel-render.test.tsx`: the button's states (enabled, read-only session, popped out, no session, outside-folder tooltip),
  and the panel writes disabled while the session works.
- `pnpm git-panel-app:check` (by hand, real session): a diverged repository with a conflict; the click sends the task, Copilot
  merges, and the panel shows `↑` to push.
- Update `docs/git-panel.md` ("Fetch, pull and push").

## Open questions

1. Send immediately when the session is idle (this plan), or always paste and let the person press Enter, as every other prompt
   the app writes does?
2. Should Copilot commit the merge (this plan, matching what it does in the terminal), or stop with everything staged so the
   commit is made from the panel?
3. Merge only (this plan), or follow the repository's `pull.rebase` setting?
