---
name: principles
description: Verification principles and status labels for Copilot CLI Desktop. Use before reporting a fix or a behaviour claim as done, and when reviewing such a claim. Covers Prove It Works, Explain the Number, Fix Root Causes, Sequence Work into Verifiable Units, Test Behavior Not Implementation and Subtract Before You Add.
---

# Verification principles

Use these when a reply claims that something is fixed, works, or got faster.
They do not apply to questions, lookups or plans.

Cite a principle only when it changed a decision, and name the decision:

> Principle: Explain the Number. Changed: raised the per-step limit only for
> listing the folder, because listing time grows with the folder while the
> other steps do not.

"No principle changed a decision" is a valid answer. A citation that changed
nothing is noise.

Build, test and check commands are in the
[README](../../../README.md#development) and in each feature's section of it.
Link the section you followed; do not restate it.

## Status labels

| Label | Meaning |
|---|---|
| PASS | The check ran and met its criterion, which was stated before running. |
| FAIL | The check ran and missed its criterion. |
| SKIP | The check did not run, with its reason. Allowed only for checks the claim does not require. |
| INCONCLUSIVE | The check ran, but the evidence cannot support or refute the claim. |
| UNVERIFIED | A check the claim requires did not run or left no result. Never report this as PASS. |

Passing checks do not make up for a required check that is UNVERIFIED.

## Evidence

A claim or review finding needs one of:

- reproducible evidence: the command and its output, a failing then passing
  check, or a measurement with its boundaries, or
- a precise source or contract argument that names the trigger, the affected
  path and the consequence.

Label untested hypotheses and the limits of the evidence. Agreement between
models or reviewers is critique, not validation.

## Prove It Works

**Rule.** Check the real artifact (the running app, the returned value, the
diff), not a proxy such as "it compiles", a log summary or a self-report.

**Applies when** you are about to say done.

**You skipped it if** the evidence is a successful build or typecheck, a check
that exited 0 without doing its work, or a statement about behaviour you did
not observe.

**In this repo.** The [README](../../../README.md#development) says `pnpm smoke`
and `pnpm cli:smoke` exit successfully without a real `copilot` binary on
`PATH`. Such a run is SKIP, not PASS. Behaviour in the real app is shown by the
Electron check scripts under `scripts/`, which drive the built app.

## Explain the Number

**Rule.** Before trusting or reporting a number (a timeout, a duration, a
count, a cost), state what produces it, what limits it, and what else could
have produced it.

**Applies when** a reply changes a limit, reports a duration or a cost, or
acts on a measured number.

**You skipped it if** a timeout was raised without saying what the waited-for
step costs and how that cost grows.

**In this repo.** Popup Local Overrides failed at a fixed 15 s limit. The fix
in commit `77bff3d` explained the number: DevTools loads the folder in
1000-file chunks of about a second each, so folders past about 15,000 files
always failed. Commit `984fa5f` then measured about 23 s to list 400,000 files
and gave that step its own limit.

## Fix Root Causes

**Rule.** Fix the first place the system did something wrong, not the place
the symptom appeared. Reproduce first, and look for the same fault elsewhere.

**Applies when** you change code to make a failure go away.

**You skipped it if** you added a retry, a longer timeout, a guard or a
swallowed error without explaining why the state arises.

**In this repo.** Commit `740b8d4` traced dialogs that hid and left pages stuck
to the order of two DevTools commands: `Page.enable` was sent only after
`Network.enable` answered, which a page with no document does not do until it
starts loading, so the alert fell through to Electron's own, often hidden,
dialog. Sending the commands together fixed the cause rather than the dialog.

## Sequence Work into Verifiable Units

**Rule.** Split multi-step work into units that each end in a state you can
check, and do not start the next unit until the current one passes.

**Applies when** a change spans several phases, processes or windows.

**You skipped it if** several behaviours land together and one end-to-end run
is the only evidence for all of them.

**In this repo.** [meeting-guests-plan.md](../../../docs/meeting-guests-plan.md)
ran spikes before phase 1, then built three phases, each recorded "as built"
and each extending `npm run meeting:check` to cover what it added.

## Test Behavior Not Implementation

**Rule.** Assert what users and callers can observe. A test should fail when
behaviour breaks and survive a refactor that keeps behaviour the same.

**Applies when** you write, change or keep a test or a check script.

**You skipped it if** the test asserts on private helpers or call order, or
its expected value came from running the code under test.

**In this repo.** Commit `7128fb9` made the dialog check assert what the user
sees: the opened page stays selected, and a background page's dialog keeps
the working page's selection and Testing mode.

## Subtract Before You Add

**Rule.** Remove dead paths, redundant guards and unused options before adding
new ones, and build the minimal version first.

**Applies when** you plan an addition, a refactor or a new option.

**You skipped it if** the change adds a parameter, a guard or a code path
alongside one that it makes obsolete.

**In this repo.** Commit `7128fb9` fixed a background dialog pulling the view
away by deleting the page switch, because the pane already shows and answers a
dialog from any page.

## Source

Adapted, in our own wording, from pstack by Lauren Tan (MIT licence,
Copyright (c) 2026 Lauren Tan,
[licence](https://github.com/cursor/plugins/blob/main/pstack/LICENSE)):
[prove-it-works](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-prove-it-works/SKILL.md),
[explain-the-number](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-explain-the-number/SKILL.md),
[fix-root-causes](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-fix-root-causes/SKILL.md),
[sequence-verifiable-units](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-sequence-verifiable-units/SKILL.md),
[test-behavior-not-implementation](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-test-behavior-not-implementation/SKILL.md),
[subtract-before-you-add](https://github.com/cursor/plugins/blob/main/pstack/skills/principle-subtract-before-you-add/SKILL.md).
