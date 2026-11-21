# File tab and rendered file views

Status: agreed in meeting QHV2 (2026-11-20, two rounds, reviewer Codex). All three phases are implemented.

Revision after phase 1:

- Viewer code is one plain script per viewer (`viewer-text.js` next to `app.js`), added with a script tag on first use and registering itself on `window.copilotFileViewers`. `npm run file-viewer:check` proves it in the built app, and `node scripts/file-viewer-app-check.mjs --asar=release/win-unpacked/resources/app.asar` proves it from inside the packaged archive.
- A click in a session's own window (a popped-out session) still reveals the file in the file manager: the panel belongs to the main window.
- A worktree root is trusted when the project's repository lists it as a linked worktree, checked before every read. A tab whose worktree was removed shows the missing state.
- While the sanitizer parses a Markdown file, Chromium logs each inline event handler in it as blocked by the content security policy. Nothing runs and the handler is not in the output.
- A path may also carry its location as `path(line,column)`, the form `tsc` prints.

Revision after phase 2 (PDF):

- The viewer is PDF.js with its own page view, text layer and find. Links, forms and scripts in a document are never made live (no annotation layer), and a document protected with a password gets the card.
- Each open document has a parser worker of its own, ended when the tab closes or the file changes. A worker started from a local file is not covered by the window's content security policy, so the worker script removes its network APIs before PDF.js loads. The content security policy itself did not need to change.
- PDF.js needs data files for some documents: character maps, standard fonts and WebAssembly image decoders. They ship under `dist/src/renderer/pdf` and are served by the main process by plain file name (`desktop:viewer-asset`), so nothing is fetched.
- PDF.js's stylesheet is kept inside the PDF view at build time (`@scope`), because it sets variables on the page root and uses class names the app also uses.
- Limits: 50 MB per file, 5,000 pages, 16 million pixels per page canvas, 64 million pixels per image inside a document.

Revision after phase 3 (Word, CSV, Excel, notebooks):

- Word: Mammoth, in a worker started for each read of the file and ended when it answers, after 30 seconds, or when the tab closes or the file changes. Before Mammoth sees the file, the app's own ZIP reader checks what the archive claims and unpacks the main part under the same limit. The HTML is sanitized in the window like Markdown; only pictures embedded as PNG, JPEG, GIF, BMP or WebP data are kept.
- Excel: the app's own reader, not a library. It reads the ZIP and the XML parts it needs with limits enforced while unpacking (64 MB for a sheet, 256 MB for a workbook), and shows cell values as text: the result saved with a formula, dates as dates, at most 5,000 rows and 200 columns of each sheet. Charts, pictures, merged cells, number formats other than dates, and macros are not shown. This was chosen over ExcelJS and SheetJS to keep the limits real and the package small.
- CSV and TSV: the app's own parser, in the window. The separator of a .csv is guessed from its first lines (comma, semicolon, tab or bar). The first row is the table head. 10 MB, 5,000 rows, 200 columns.
- Notebooks: rendered in the window with the Markdown and code views. Saved text, error and PNG or JPEG outputs are shown. Output saved as HTML, SVG, script or a widget is never put in the page; its plain-text form is shown when it has one. A notebook that is not valid JSON, or too large to render (8 MB of HTML), is shown as its source with the reason. 20 MB.
- CSV and notebooks keep a **Source** view, as Markdown does.
- The workers' lock-down is shared (`worker-lockdown.ts`). `importScripts` is kept as a function that throws, because a library bundled with Mammoth looks for it to tell a worker from a window.
- Not done: PowerPoint, the old binary Office formats (.doc, .xls), OpenDocument files. They get the card.

## Problem

Clicking a file path printed in a session terminal opens the file manager with the file selected (`desktop:reveal-path` in `src/main/main.ts`, called from `openLink` in `src/renderer/components/TerminalPane.tsx`). The file should open in a tab in the right panel, with a rendered view for Markdown, PDF, Word and other common formats.

## Behavior

1. A plain click on a file path opens it in a File tab in the right panel and shows the panel. Ctrl+click (Cmd+click on macOS) reveals it in the file manager as today. Folder paths still reveal. The link's activation passes its mouse event through so the modifier is seen.
2. One tab per distinct file. Clicking an open file focuses its tab. At most 20 File tabs per workspace; a 21st asks the person to close one.
3. Link detection keeps the `:line:col` location, including on bare relative paths (`src/app.ts:42:7`) and quoted Windows paths with spaces. The tab scrolls to and marks that line. A second click at another line moves the open tab there.
4. File tabs are workspace tabs and follow the right-panel rules of [Optional right-panel tabs](right-panel-tabs-plan.md): own close button, hide keeps state, closing the last tab removes the panel, no remount on session switch.
5. The tab header has Reveal in folder, Open with default app, Copy path and Reload.
6. The Git panel's changed-file rows get an Open file action that uses the same tab.
7. A path outside its root, or a missing file, gives the same quiet notice as today.

## Tab identity

A file's identity is the pair (root identity, relative path). The root is the workspace folder or one specific worktree. The main process resolves it from trusted project and worktree records, never from the renderer. The same pair is used to deduplicate, save and restore, because two worktrees can hold different versions of the same relative path.

The project manifest saves the pair only; content is read again on restore. If the root or the file is gone, the tab shows a missing state with a Close button. It is not dropped silently.

## Reading files

A new main-process IPC reads a file for a tab:

- trusted-sender check, as other desktop IPC;
- `realpath` of both root and target, so a link cannot escape the root;
- type from the extension, then a sniff of the first bytes;
- size limits: text and Markdown 2 MB, images 25 MB, PDF and Office files 50 MB. A larger file shows the fallback card.

## Live refresh

- Watch the file while its tab is shown, with a 300 ms debounce.
- Check modified time and size every time the tab is shown again, because the watcher stops while hidden.
- Attach the watcher again after a save-by-rename.
- Ignore a read that finishes after a newer one started.
- Keep the scroll position.

## Viewers

| Format | View | Library |
|---|---|---|
| Markdown | Rendered by default, with a Source toggle. Tables, task lists, highlighted code blocks | markdown-it, DOMPurify |
| Code and text | Read-only, line numbers, highlighting, find, wrap toggle | highlight.js |
| Images | Fit or actual size. SVG through `<img>` only, never inlined | none |
| PDF | Page scroll, zoom, selectable and searchable text | PDF.js, loaded on first use |
| Word (.docx) | Headings, lists, tables, images | Mammoth, DOMPurify |
| CSV, TSV | Table with a sticky header | own parser |
| Excel (.xlsx) | Sheet tabs and cell values, read-only | own reader |
| Notebook (.ipynb) | Markdown and code cells with saved outputs | the Markdown and code views |
| Anything else | Card with name, size and modified time | none |

Markdown loads local images through the read IPC as `data:` URLs, so the renderer's content security policy stays as it is. Remote images are not fetched. Web links open in the system browser; relative links to files under the same root open in a File tab.

For executable and other unsupported types the fallback card offers Reveal in folder only, not a shell launch.

Local HTML opens as source only. Opening it in a Browser tab needs its own navigation and isolation design and is out of scope. Editing files is out of scope.

## Safety and limits

- Every file is untrusted input. All generated HTML goes through DOMPurify. No file content can cause a network request.
- PDF, Word, Excel and notebook parsing run in workers with no DOM or preload access. The policy gains `worker-src 'self'` only.
- Each parser has its own limits on work and memory beyond the file size: decoded zip entry sizes and counts, a PDF page and canvas pixel budget with pages rendered on demand, notebook output size, and generated markup size.
- An oversized, failed or cancelled parse falls back to the card.

## Loading viewer code

Viewer code loads only when a file of that type is first opened. `scripts/build-renderer.mjs` emits IIFE bundles today and `index.html` loads a classic `app.js`, so phase 1 starts with a spike that picks the bundle strategy (ESM splitting, or one extra bundle per viewer) by proving that chunk and worker paths load in the packaged, offline asar build. That packaged check is repeated for each viewer.

## Phases, one PR each

1. File tab, link routing with location and modifier, read IPC, root identity, refresh, code and text, Markdown, images, fallback card.
2. PDF.
3. Word, CSV, Excel, notebook.

## Acceptance cases, proved in the real app on Windows

- Bare `src/app.ts:42:7`, and a quoted Windows path with spaces.
- A second click on the same file at another line.
- Two worktrees with different versions of the same relative path, surviving an app restart.
- Hide, edit, show; and an editor's save-by-rename.
- A path outside the root and a link escaping it are refused.
- Selectable and searchable PDF text.
- A Word document with a basic table.
- An oversized parse and a cancelled parse.
- Each lazy viewer in a packaged offline build.
