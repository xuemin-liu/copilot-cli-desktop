---
name: bug-fix
description: Use when fixing a Copilot CLI Desktop bug or regression, before reporting it fixed, and when reviewing such a fix. Covers reproducing the failure on the surface where it appeared, narrowing the cause, the smallest fix, verifying on the same surface, and pasting the failing and passing output.
---

# Bug fixes

Use this with the `principles` skill, which defines the status labels; Fix
Root Causes and Prove It Works apply most. Build and test commands are in the
[README](../../../README.md#development).

## 1. Reproduce on the same surface

Reproduce the failure where it appeared, and record the command and its
failing output:

- **Pure logic** (main-process state, parsing, IPC payloads): a unit test next
  to the module, `*.test.ts`, run with `corepack pnpm test`.
- **Behaviour in the running app** (windows, terminals, browser pane, Git
  panel, meetings): the matching Electron check script under `scripts/`, run
  through its `package.json` script (for example `browser:check` or
  `meeting:check`). Extend the check so it shows the failure.
- **Copilot CLI interaction:** a real `copilot` session where the check needs
  one. Without `copilot` on `PATH`, smoke runs exit successfully without doing
  the work, which is SKIP, not a reproduction.

If it does not reproduce, narrow the conditions or add logging until it does.
Hand reproduction to the user only when you cannot reach the surface, and say
exactly why.

## 2. Narrow the cause

List the hypotheses, then eliminate them, each time choosing the check that
rules out the most. Prefer runtime evidence over reading code. Stop at the
first place the system did something wrong, not where the symptom showed: an
event ordering, a process boundary or a missing state transition rather than
the component that displayed it.

## 3. Make the smallest fix

Change only what the evidence supports. Do not add a retry, raise a timeout,
swallow an error or relax a check to make the failure go away. Look for the
same fault on sibling paths (Windows, macOS and Linux; main and renderer;
pop-out and docked windows) and fix every instance you can reach.

## 4. Verify on the same surface

Run the original reproduction again; it must now pass. A different surface, a
unit test that only covers a branch, or an inconclusive run is not a pass.
Then run `corepack pnpm typecheck` and `corepack pnpm test`, plus the check
scripts that cover the touched area.

Commit order follows repository practice; a separate failing-test commit is
not required.

## 5. Report

```text
Broken: <observable behaviour and where>
Root cause: <first wrong decision, with the evidence that confirms it>
Fix: <what changed, and sibling paths checked>
Reproduction: <command>
Before:
<failing output, verbatim>
After:
<passing output, verbatim>
Other checks: <typecheck, tests, check scripts, with status>
Limits: <platforms or surfaces not verified>
```
