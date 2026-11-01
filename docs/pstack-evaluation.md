# pstack evaluation

Status: evaluation done and independently reviewed (see [Review log](#review-log)); one idea adopted (#141). Written
after that change, so this records the reasoning and the remaining candidates rather than a plan.

[pstack](https://github.com/cursor/plugins/tree/main/pstack) is Lauren Tan's MIT-licensed skill collection for rigorous
AI-assisted engineering, written for Cursor. It has three layers of plain `SKILL.md` folders:

- `poteto-mode`, a router that matches a request to one of 23 playbooks (bug fix, perf, feature, eval, shipping,
  multi-phase plan, babysit a PR, session pickup, …) and copies the playbook's steps into the todo list.
- 34 other skills, among them `interrogate` (adversaries try to break a change; only findings proven by a run survive),
  `arena` (several candidates do the same task, a judge from another model family scores them, the best is the base and
  the others' strongest parts are merged in), `swarm` (split a task into slices, or race workers under a selection rule
  declared first), `correct`, `tdd`, `show-me-your-work`, `unslop` and `no-comments`.
- 24 `principle-*` skills used as named steering vocabulary ("Prove It Works", "Fix Root Causes", "Explain the Number"),
  where the agent names each principle it applied and the decision it changed.

The question was what this project could borrow, in two senses: how we develop it, and what the app could offer its
users. Each idea below is marked adopted, covered, covered in part, later, or dropped.

## How we develop this app

This repository is developed with Claude Code, through the maintainer's own commands in `~/.claude/commands`:

- `ship-phases`: a reviewed plan in `docs/<feature>-plan.md`, one PR per phase, real Electron checks, and for every fix a
  run showing its test fails without the fix.
- `fix-pr`: triage review comments against the code, fix valid ones with tests, reply on each thread.
- `review-pr`: one reviewer that checks findings with tests or reproductions where practical and says what it verified.
- `release-unsigned`.

| pstack idea | Here | Verdict |
| --- | --- | --- |
| Multi-phase plan, verifiable units, opening a PR, babysitting it | `ship-phases`, `fix-pr`, the `docs/*-plan.md` files | Covered |
| `tdd`, Prove It Works, verify on the same surface | `ship-phases` step 4; fixes extend the matching Electron check (`740b8d4`, `7128fb9`) | Covered, more strictly |
| Bug-fix playbook for a single bug | `ship-phases` is for multi-phase features; no command covers one bug fix | Later |
| `interrogate` for PR review | `review-pr` verifies where practical, but it is one reviewer and keeps findings it could not run | Covered in part |
| Fix Root Causes, Explain the Number | Practised in commit messages (`740b8d4`; `77bff3d` and `984fa5f` explain the 15 s timeout before changing it) | Covered in practice; not written down |
| `correct`: recurring review mistakes become architecture, types or lint, then tests | Regressions become check-script cases (the test level only); a rule such as "a feature PR does not bump the package.json version" lives only in `review-pr`'s text, not in CI | Covered in part |
| Principles as cited vocabulary, status labels | `ship-phases` says "report faithfully" | Dropped: little gain over current practice |
| Install pstack itself (`/plugin install pstack@cursor-plugins` in Claude Code, which uses upstream's generated, already remapped copy) | — | Dropped for now: its router and playbooks overlap the commands above; the one missing playbook is smaller to add directly |

A first attempt, #140, put a principles skill, a bug-fix skill and a paragraph in `.github/copilot-instructions.md`. It
was closed because of where the files lived: only Copilot CLI and Copilot code review read `.github/`, while this
repository is developed with Claude Code. Its content came from a plan written for another repository, but the bug-fix
skill itself had value: it required the failing reproduction first and the same reproduction passing after, verbatim,
and it added what `ship-phases` lacks for a single bug (ruling out hypotheses, no retries or raised timeouts in place of
a cause, checking sibling paths, a smoke run without `copilot` counted as SKIP). That is the bug-fix item under
[Later](#later).

Limit: the commands are user-level, so they apply to the maintainer's sessions, not to every contributor's agent.

## What the app could offer

| pstack idea | In the app | Verdict |
| --- | --- | --- |
| `interrogate`: adversarial review keeping only findings proven by a run | [Review meetings](../README.md#review-meetings): any session, any model, outside agents; rounds until every reviewer agrees. Reviewers get no worktree of their own, and the recommended Restricted reviewers have no shell at all, so they can cite source but not run checks | Covered in part |
| A finding states its evidence; untested points are labelled | Was missing: reviewers were asked only what is wrong, missing or agreed | **Adopted** in #141 for review, vote and discussion messages, for desktop sessions and outside agents |
| `arena`: parallel candidates, a cross-family judge, grafting | Fan-out runs the same prompt in up to five worktree sessions; the comparison is left to the person | Covered in part; judged comparison under Later |
| `swarm`: slices or races under a declared selection rule | Fan-out races identical briefs; no slicing and no selection rule | Covered in part |
| Playbooks and the router as a product feature | Copilot CLI skills and plugins, which the app manages through official commands ([feature parity](FEATURE_PARITY.md)) | Dropped: a playbook library in the app would duplicate CLI skills |
| `visual-parity`: screenshot baseline, pixel diff, frozen baseline | Debug browser Testing mode gives step reports and screenshots, but no baseline comparison | Covered in part |
| Per-role models | Each meeting reviewer and session chooses its own model | Covered |
| `session-pickup`, `pause-safely` | Session resume and restored tabs; an idle summary is under Later in the [agent workbench plan](agent-workbench-plan.md#later) | Covered in part |
| `autonomous-run` | `copilot-desktop run --autopilot --max-ai-credits` | Covered |
| `show-me-your-work` decision log | Meeting transcripts; otherwise the model's own behaviour | Dropped: not an app concern |
| `unslop`, `no-comments`, model routing setup, Cursor automations, Bugbot | — | Dropped: one person's style, or Cursor-only |

## Adopted

#141 (`e2ed661`) adds an evidence rule to the messages reviewers answer. A review asks each finding to say what supports
it: a check the reviewer ran, with the command and what it showed, or the source that shows it, naming the trigger,
where it happens and what goes wrong; anything unchecked is marked untested. A vote asks an objection to name each open
item and what supports it. A discussion round asks the same of each disagreement or new point. The host can then tell a
checked problem from a guess.

Limits: a Restricted reviewer cannot run commands, so for the setup the README recommends, the evidence is the source,
not a check. Whether reviewers follow the rule, and whether it improves findings, has not been measured.

## Later

Each would be a small, independent change:

- **A bug-fix command.** A user-level `~/.claude/commands/bug-fix.md` (or a `.claude/skills/` skill) for one bug,
  reusing #140's content, beside `ship-phases`.
- **Measure the evidence rule.** pstack's `eval` playbook runs sanitized, parallel candidates and a blinded judge from
  another model family. Run old and new reviewer messages against a patch with planted defects and compare the findings.
- **The host weighs evidence.** The host's digest could say that untested findings are untested, so checked ones are
  acted on first. Only reviewer messages changed in #141.
- **Judge a fan-out in a meeting.** After a fan-out, a meeting could ask reviewers to compare the worktrees against the
  task and name the strongest with evidence, as `arena`'s judge does. Untested idea: it needs a design for passing
  several worktrees' diffs as material.
- **Encode a recurring review rule.** The "no version bump in a feature PR" rule could become a CI check, as `correct`
  suggests, instead of reviewer text.

## Sources

From pstack: the [README](https://github.com/cursor/plugins/blob/main/pstack/README.md) (including the Claude Code
install), the [Claude Code adapter](https://github.com/cursor/plugins/blob/main/pstack/docs/harness/claude-code.md),
`skills/poteto-mode/SKILL.md` and its `bug-fix`, `eval` and `visual-parity` playbooks, and the `interrogate`, `arena`,
`swarm`, `correct`, `tdd`, `benchmark-checklist` and six `principle-*` skills. The adapter shows the skills are not
harness-neutral: Cursor's `Task` and `AskQuestion` tools and its subagent names must be remapped.

## Review log

A reviewer with no part in writing this checked every claim against the repository, the maintainer's commands, #140 and
pstack's sources. It found ten issues, all addressed here: the reason given for closing #140 was wrong (its bug-fix
skill did require a failing reproduction); `arena` and `swarm` were described wrongly; `interrogate`, `visual-parity`,
`correct` and `review-pr` were overstated as covered; the Restricted-reviewer limit was missing; the `eval` playbook and
the Claude Code plugin install were not considered; and "CLI scheduling" had no source.
