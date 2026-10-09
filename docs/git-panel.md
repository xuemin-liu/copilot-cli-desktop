# Git panel

The Git panel shows the state of the Git repositories in your project folder next to the session, so you can review what
Copilot changed without leaving the app. You can review changes, stage and unstage files, make local commits and hand context
to Copilot. Fetch, pull, push, branches and discarding changes are not in the panel yet and are still done in the terminal (or by
Copilot). See the [plan](git-panel-plan.md) for what comes next.

Open it from the Git icon in the session header, or with **Ctrl+Shift+G** (the key is handled before the terminal or the
debug browser sees it). Close it the same way. Its width and open state are remembered.

## What it shows

- **Repositories.** The project folder itself, or every repository found inside it (up to three folders deep, at most 25).
  Folders reached through links or junctions are not followed. If the project sits inside a larger repository, that
  repository is listed as "(parent)", unless it is your home folder or a drive root, which are ignored.
- **Changes.** Staged, changed, untracked and conflicted files for the selected repository, and the branch with its
  upstream and ahead/behind counts. The list updates a moment after a session's activity changes (for example when Copilot
  starts or finishes working), when the window regains focus, and every 20 seconds as a fallback. **↻** rescans the folder.
- **Diff.** Select a file to see its diff, coloured by line. Untracked files are shown as all-added. Binary files, folders
  and very large files show a notice instead of content.
- **History.** The latest commits, 50 at a time. **Load more** waits for the page in flight, so a double click never lists a
  commit twice or skips one.

## Staging and committing

- **Stage and unstage** with the **+** and **−** button on each file, or **Stage all** / **Unstage all** on a group. Folders of
  untracked files stage as a whole. A conflicted file has a **✓** that marks it resolved. Only the files you can see are acted
  on: when the list is cut off at 5,000 files, the group-wide buttons are disabled rather than doing half the job.
- **Commit** takes the message you type (Ctrl+Enter also commits) and records exactly that text, whatever it contains. It is
  refused, with a reason, when nothing is staged, the message is empty or conflicts are unresolved.
- Git has to know who you are. If `user.name` or `user.email` is missing the panel says so and shows the two commands to run;
  it never changes your Git configuration.
- **Hooks.** A commit runs the repository's own hook files (`pre-commit`, `commit-msg`, and the few others a commit can
  trigger). A repository can arrive with hooks you have never seen, so the first commit lists them and waits for you to allow
  them. Your approval is remembered for those exact files and asked again if any of them changes. Staging never runs hooks.
- While a commit runs, whatever the hooks print appears under the message box, and **Cancel** stops the whole process tree. If
  Git left a lock file behind after a cancel, the message says which file to delete; the panel never deletes it for you.
- Writes happen one at a time per repository. If another program (Copilot, an editor) is using the repository, the panel waits up
  to ten seconds for its `index.lock` and then says that another Git process is busy.
- Every write quotes the file list you were looking at. If the list changed in the meantime, the request is refused and the
  list refreshes, so a click can never stage or unstage a different file than the one you meant.

## Giving context to Copilot

- **Add to prompt** puts the selected diff in the prompt box of the active session. Nothing is sent: review it and press
  Enter. The text is kept under 11,000 characters and says how many lines were left out.
- **Draft commit message with Copilot** (shown when files are staged) puts a prompt in the box asking for a
  conventional-commit message. It reads up to 30 staged diffs and shares the space between them; every other staged file is
  still named and counted in the prompt, and a note says if the file list itself was cut off, so a message is never drafted
  from part of a commit without saying so.
- Files that look like they hold secrets (`.env*`, `*.pem`, `*.key`, `id_rsa`, `secrets*`, `.npmrc` and similar) are named
  but their contents are never added. Values that look like credentials in other files are replaced with `[REDACTED]`.
  This is a safeguard for the common shapes, not a guarantee.
- If the active session is open in its own window, the buttons are disabled: the panel lives in the main window.

## Repositories that need review

A repository's own settings (`.git/config`) can make Git run programs: clean filters, `core.sshCommand`, credential
helpers, a custom excludes or attributes file, includes, URL rewrites and similar. Because opening a repository you did not
create can then run something, the panel does not read such a repository until you have looked at those settings.

It lists them **in full** and offers **Trust this repository**. Trusting accepts the whole value of every setting, so nothing is
shortened: a long run of spaces, a line break or an invisible character is spelled out in ⟦ ⟧ marks, so a command cannot hide
behind padding. A setting longer than 8,000 characters cannot be trusted from the panel at all; inspect it in a terminal. Your choice is remembered for that folder and those exact settings; if
they change, you are asked again. The standard Git LFS settings do not need review.

A repository whose `.git` points at a network share, links elsewhere, or names objects outside local storage is shown as an
error and is never opened. This is checked again before every command, not only when the panel opens.

## Requirements and limits

- **Git for Windows 2.30 or newer** on the machine. Without it the panel says so and the rest of the app is unaffected.
- The panel runs Git only while it is open and the window is visible. Hiding the window to the tray, minimizing it, or
  closing the panel stops all of it.
- Only the main window has the panel; a session popped out to its own window does not.
- A very narrow window gives the panel the whole area instead of squeezing the terminal; closing it returns the session.
- Fetch, pull, push, branch switching, amending and discarding changes are not in the panel yet.
- Git reads your identity from its configuration, not from `GIT_AUTHOR_NAME`-style environment variables, which the panel
  deliberately does not pass on to Git.
- Submodules are not listed (reading them would run Git inside another repository). If a submodule update is staged, Commit is refused
  with the paths named, instead of including changes the list never showed; unstage it or commit from a terminal.

## Checks

- `pnpm git:check` runs the real main process and the real bridge against throwaway repositories.
- `pnpm git-panel:check` renders the real panel in Electron against a real service and saves screenshots under
  `test-results/git-panel/`.
- `pnpm git-panel-app:check` starts the whole app with a real Copilot CLI session and checks the header button,
  `Ctrl+Shift+G` with the terminal focused, persistence across a reload, the narrow-window takeover, and that the terminal is
  never remounted. It starts a real session, so like the other real-session checks it is run by hand, not in CI.

The first two run in CI.
