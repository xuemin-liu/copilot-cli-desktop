# bug-fix acceptance

These expectations are fixed before the skill is first tried. Revising the
skill text never changes them; a revision reruns the trial. The trial is the
next real bug fix, named before the skill text is final.

A reply passes when it records the failing reproduction first, then the passing
check on the same surface, both verbatim, with the root cause and the evidence
that confirms it. Commit order follows repository practice; a separate
failing-test commit is not required. A different surface, an inconclusive
rerun, or a smoke run that skipped for lack of `copilot` is not a pass.

If the trial cannot be run, record it as UNVALIDATED with the reason.
