# Workflow capability evidence

Run `npm run workflow:check` from a checkout with dependencies and a locally installed Copilot CLI.
It builds Desktop, runs the binding/turn/input/replay regression fixtures, then invokes the real CLI with a disposable
profile and loopback model. It never uses a live model account or starts a production review meeting.
Results are saved under ignored `test-results/workflow-capabilities/result.json`; failure output is redacted.

Observed 2026-11-02 on Windows with CLI 1.0.105: the regression group and live A/B/B/A helper check passed.
The runner also executes the successful-restart lifecycle regression and the failed-setup/unload/close regressions as
separate checks. It verifies every expected TAP test name, rejecting zero-test or partially matched selections.
No crash-safe consumption receipt was established. Automatic resubmission remains unsupported.

| Capability | Evidence | Product policy |
| --- | --- | --- |
| Submitted human turn | Live `user.message` plus the existing turn reader | Historical replay cannot authorize new work |
| Managed session ownership | Process ancestry, root-session records and CLI locks | Unknown or multiple retained recipients block automatic input |
| Helper invocation | Real CLI A → B → B → A regression | The helper's session hint must pass ownership verification |
| Draft and picker protection | Session task/PTY regressions and separately selected restart/setup-failure/unload/close cases | Busy/draft/recent input waits; failed setup restores only the original healthy recipient; stopping cancels pending Enter and held keys |
| Turn boundaries and replay | Turn reader and permission monitor regressions | End of a turn is activity evidence, never task success |
| Crash-time delivery receipt | No durable correlated consumption receipt established by these checks | Persist uncertain delivery and require reconciliation; do not resend automatically |

The result records the exact CLI version and platform. Passing it on one version/platform does not establish support
on another. Future workflow dispatch must require positive runtime binding and provenance evidence in addition to a
tested CLI version; version parsing alone cannot grant permissions. Unknown event formats retain ordinary terminal use
and show an unknown task outcome. These checks do not establish task-report helper support, a structured question API,
or safe automatic resubmission after a crash. Each requires its own implementation evidence before enabling it.

This implements the repeatable evidence collection for Phase 0 of the [workflow plan](task-workflows-plan.md).
The result is a verification artifact, not a configuration file that enables automation.

The lifecycle fixtures cover successful restart, failed setup for Git context/task/command/rename input, close requested
during failed setup, a native switch during failed setup, and deliberately delayed unload/close stops. Restoration is
allowed only before any stop request, while the same process and native recipient remain live and idle. Once stopping
starts, pending input is discarded; no consumption or crash-time receipt is inferred from these checks.
