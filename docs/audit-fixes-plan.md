# Audit fixes plan

Revision 1, 2026-11-21. Source: a code audit of v0.1.127 (`9f1d6e4`), checked in review meeting QEBT (two outside
reviewers, three rounds, agreed). One pull request per phase. Every fix has a test that fails without it.

| Phase | What | How it is proved |
|---|---|---|
| 1 | The read-only preset refuses to start when the CLI's capability probe failed, in the desktop and in the daemon. The deny-tool fallback stays only for a CLI whose `--help` was read and shows no tool allowlist. The refusal is decided before a restart stops a live tab. | Unit tests |
| 2 | The Git trust review covers what a repository's `include` and `includeIf` files bring in, and the keys `core.alternateRefsCommand` and `http.*`. A scan that cannot be completed counts as "needs review". | Unit tests against real Git |
| 3 | The Git panel keeps the repository it first showed until that repository goes away or the person switches. The selected diff is refreshed when its file changes again. Push honours `branch.<name>.pushRemote` and `remote.pushDefault`, or refuses. A status too large to read is a clear limit state, not a failure. | Unit tests against real Git; `git-panel:check` |
| 4 | Desktop control screenshots mask a blocked window only where it can be seen: an allowed window above it removes the mask only over pixels it is proven to cover opaquely. The unchanged-patch check does not pass on masked pixels. A window of this process is always "self". Window-switching chords are refused as families. A drag's end point is checked like its start. | Unit tests; `desktop-control:check` |
| 5 | A meeting with no reviewers left goes back to waiting instead of opening a round nobody can answer. A close vote does not survive into a revised post. A post held at the round limit is kept when everyone has left. | Unit tests |
| 6 | Terminal reports (focus, mouse, cursor replies) do not clear an approval badge. A session is never "running" without a live process. `copilot-desktop start` checks the folder. A stale state or lock file whose process id now belongs to another program is recovered. | Unit tests; `cli:smoke` |
| 7 | Startup survives a failed settings save. Installing or updating the CLI and starting a Copilot session exclude each other. A workspace is never evicted without the cleanup that removing it does. "Save log" takes one snapshot. | Lifecycle tests |
| 8 | A meeting reads a folder's changes only with the person's grant for that folder: a host invitation that carries it, or a remembered per-workspace choice. The MCP endpoint takes a per-install token. Joining a meeting that has private material by id alone needs the host's approval. | Unit tests; `meeting:check` |
| 9 | An automation over its daily limit waits for the next day and is checked again before it starts; only the lifetime limit is final. A rule can be deleted. | Unit tests |
| 10 | A browser test compares an editable field's live value only when the test set it or it comes from an authorised fixture; otherwise the step is refused as private. | Unit tests; `browser-test-check` |
| 11 | Terminal link detection is bounded on long lines and does not take ratios or dates for paths. The source view of a file has a line budget. | Unit tests with timings; `links:check` |
| 12 | Activity broadcasts are coalesced across tabs, only if measurement shows a gain. | Measurements in the PR |

Not planned: splitting `main.ts` further, a focus trap for dialogs, the Electron update. Each is a separate decision.

## Failure and security notes

- Phase 1: a person on a slow machine may see a refused read-only start they could have had before. The message says
  to try again; nothing weaker starts silently.
- Phase 2: a repository that uses `include` is held for review whenever an included file changes. Global and system
  config keep today's policy.
- Phase 3: with a partial or oversized status, bulk writes (stage all, discard all) stay off.
- Phase 4: the worker reports a rectangle and a click-through flag, which prove neither opacity nor shape. Layered,
  translucent and region-shaped windows therefore unmask nothing; ambiguous coverage stays grey. Explorer and the
  other blocked programs stay blocked as targets.
- Phase 6: a controller that is alive but slow must not be taken for stale; recovery needs a process identity that
  does not match (start time), and keeps the exclusive recovery lock.
- Phase 7: eviction cleanup never removes anything outside app-owned storage.
- Phase 8: being a workspace is not a grant. The token authenticates a client and is never taken as the person's
  intent, because a local process can read an authorised client's config.
- Phase 9: a deferred automation never replays an event whose evidence no longer holds.
- Phase 10: no naming heuristic decides that a field is safe.
