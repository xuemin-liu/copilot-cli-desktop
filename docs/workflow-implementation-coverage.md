# Workflow implementation coverage

Audited against `task-workflows-plan.md` on 2026-11-02. An approved feature PR establishes only its stated scope;
it does not establish every item in the broader plan. The feature branches are stacked and remain unmerged.

| Plan area | Existing implementation | Remaining acceptance work |
| --- | --- | --- |
| Phase 0: integration evidence | PR155: disposable CLI probe, tested-version gate, binding/input fixtures | The successful-restart runner omission is fixed in parent PR155; failed-setup restart and unload/close input holds still need their own lifecycle implementation/coverage. Crash-time consumption remains deliberately unsupported and uncertain |
| Phase 1: attention | PR156: cross-project reasons, acknowledgement, notifications, navigation | Surface task attention when its tab is closed; order questions/failures ahead of review results; notify new task outcomes and coalesce bursts |
| Phase 2: task records | PR157 and PR162: stable task/assignment, rich reports, host links and retained active tasks; this PR adds explicit adoption/new task, manual outcomes, supported resumption and history deletion | Show current linked-resource availability without recreating missing resources |
| Phase 3: recovery | PR158 and PR161: journal, original-recipient gates, local meeting migration, reconciliation | No additional automatic resend is planned: there is no proven crash-safe consumption receipt |
| Phase 4: GitHub follow-ups | PR159: per-task enrollment, current-version polling, allowlists, limits, pause | Project default templates with explicit acceptance; optional verified PR-merge completion; batch related feedback |
| Phase 5: rule preview | PR160: bounded templates, Preview/Automatic/Off, ownership, budgets, project/global pause | No new template identified as missing; rule-created investigations intentionally remain read/search only |

The task-details change adds bounded, redacted questions, artifacts, tested revisions and the latest twenty report
records. Host observations retain origin, creation time, repository/worktree/branch, comparison group, meeting IDs
and the enrolled PR. Reports cannot rewrite those ownership/scope links. Schema v1 has a readable SQLite backup before
v2 is enabled. Missing files are never recreated by reading task history. Paths are recorded references, not proof
that a resource still exists; URL actions use the existing HTTP(S) navigation check.

Follow-up PRs must close the remaining entries with code and validation evidence. Updating this table alone does not
close an item. Build, typecheck, focused tests and current-head reviewer approval must be reported separately from
merge/release status. No live paid model run or production automation enrollment is implied by fixture coverage.

Untrusted artifact actions show their full redacted URL before navigation, and historical reports render their retained artifact references as well as their validation.
