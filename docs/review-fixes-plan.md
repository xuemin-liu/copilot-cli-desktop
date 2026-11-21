# Review fixes plan

Revision 1, 2026-11-20. Source: a read-through review of v0.1.126, checked in review meeting G7AC (one outside
reviewer, three rounds, agreed). One pull request per phase.

| Phase | What | How it is proved |
|---|---|---|
| 1 | A session terminal whose history request fails still shows live output. A Settings window whose page fails to load is destroyed. Ctrl/Cmd+W and Ctrl/Cmd+T pressed in a text field of the workspace tools act on tool tabs, never on the session, both as a key event and as a menu accelerator. | Unit tests; real keys in `optional-tabs-app-check.mjs` |
| 2 | A click on a path in the session terminal opens the file without the click also reaching the CLI. | Unit tests; real click in the app |
| 3 | The main window reloads after its page process dies, a bounded number of times, and logs it; an unresponsive page is logged, not reloaded. Unhandled rejections and fatal errors are written to the app log without changing how the app exits. | Lifecycle tests |
| 4 | Find marks in a File tab survive switching tabs. The Add workspace dialog takes focus and closes on Escape. A split terminal keeps its scrollback when the clipboard setting changes. | Reproduce each in the app first |
| 5 | The CLI version that task reporting, follow-ups and automations were qualified on lives in one constant, and the app says which version is installed and which feature it turns off. The exact pin stays (`docs/workflow-capabilities.md`). | Unit tests |
| 6 | Fan-out asks for one tab's readiness, not the whole state and backlog. Measure broadcast cost (calls by caller, time, payload size, event-loop delay) before any caching. | Unit tests; measurements in the PR |
| 7 | The session log folder is created once per tab. Output batching only if log order, the byte cap and replay sequences are preserved. Tool terminals poll less while hidden; polling stays as the recovery path. | Unit tests; terminal checks |
| 8 | CI runs on pull requests. `links:check` runs on Windows as a job that cannot fail the build, until it has proved stable. | The workflow run |
| 9 | The main renderer bundles are minified. | Startup time before and after |
| 10 | `fast-uri` and `js-yaml` advisories: confirm paths and ranges, update within the parents' constraints, override only where needed, rerun the production audit. | `pnpm audit --prod` |
| 11 | Extractions from `main.ts`, only where regression tests already cover the moved code. | Existing suites |

Not planned: a linter; the `electron-store` major upgrade (a separate decision).

## Failure and security notes

- Phase 1: an empty history fallback loses the output printed before the failed request; that output is still in the
  session log. The accelerator is handed to the page only when the main window is focused; chosen with the mouse, the
  menu items act on the session as labelled.
- Phase 3: reloading is bounded so a page that dies on load cannot loop.
- Phase 10: one `fast-uri` advisory has no known fixed version; record what remains.
