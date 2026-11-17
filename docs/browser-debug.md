# Debug browser and Local Overrides

Choose **New tab → Browser**, enter an address, or use **Open browser** in a CLI header to create a browser for the current session. Browsing also works with no CLI running. Browser pages and Git share one top-level tab strip; **+** opens another launcher. Close any individual tab, including the last. **Hide tabs** retains pages; **Show tabs** restores them.

Pages belong to a project and share its cookies, storage, Local Overrides and capture group. Separate profiles are the default; Settings can share cookies across projects. The cap is 32 live pages across all projects, including popups and hidden projects. CLI focus never changes the selected page. The current running CLI connects automatically. Switching sessions or selecting a Browser tab updates its target; CLI page selection remains independent until the user changes session or page. Inactive sessions cannot control the browser. A closed CLI-selected cursor stays empty until the CLI selects a page or the user changes the selected Browser tab.

Bare public domains use HTTPS; development, private and loopback hosts use HTTP. Explicit HTTP/HTTPS takes precedence. **Reload** uses the cache; **Shift+click**, **Ctrl+Shift+R**, or **Ctrl+F5** bypasses it. Links and `window.open()` create top-level Browser tabs while preserving their opener. **Open in window** moves one page into its own window and out of the tab strip; the panel moves to a neighbouring tab, or shows **No tabs**. The window's toolbar has **↻** (a click reloads; **Shift/Ctrl/Cmd+click** bypasses the cache) and **Return to panel**, which puts the page back in its old place with the same page and form state. Popups may open windows from a detached opener. Closing asks before discarding unsaved page changes; Cancel retains the page.

A page in its own window stays under the agent's control. The session's browser follows the page you last selected or clicked into, in the panel or in its own window, and moving the panel to another tab does not move it. A session window's **Show browser** brings that page forward. Screenshots and test interactions need its window shown, not minimized; text snapshots still work while it is minimized.

The address toolbar shows the selected page's actual browser zoom percentage.
Zoom is remembered per site (host name, as in Chrome) for every project's browser and
kept across restarts; returning a site to 100% forgets it.
Opening a child page preserves the source page, POST data and opener callbacks.
Only the primary page's saved URL is restored after app restart; additional pages are temporary.
Projects retain browser cookies and storage across tab closure, CLI closure and app restarts. Saved tabs restore lazily; saved URLs and Recent pages omit sensitive URL components. Closing a CLI removes its control bridge and helper files, without closing project pages or signing out. Restart/Resume reconnects the current session automatically. Removing a workspace drops its tab manifest and separate profile identity; startup prunes that profile. Shared cookies remain available to other projects.

Switching tabs or hiding retains typed addresses, find text, collected elements and notes. Hiding stops a running test and picking; tests never resume automatically. App startup does not restore a neutral launcher or any CLI browser connection. Upgrades from session-owned browsers start with no open tool tabs and new separate project profiles; old session cookies are not merged.

Select **DevTools / Overrides**, then **Sources → Overrides** in the embedded
DevTools. Select the folder you already use for Chrome Local Overrides and enable
Local Overrides. Chrome's saved override files are ordinary local files and can
be reused. The folder selection must be configured once in this app; Chrome's
profile settings are not imported automatically. The overrides folder and other
DevTools settings, including whether Local Overrides is enabled, are shared by every
project that uses shared settings (the default): a browser opened later starts with the
settings the others saved (Chromium saves them a few seconds after a change), and they
are kept after its pages close. Console history is shared too.

Choose **Browser settings → Local Overrides for this project** for private or shared settings. New projects use the default in **Settings → Project browsers**. Private DevTools folders stay in the project's own partition. A changed choice applies after all its browser pages close and a new Browser opens. With shared cookies, the overrides switch is also shared; private folders remain separate.

The browser footer shows whether Local Overrides applies to the selected page: **on** with the overrides
folder (green), **off**, or a warning when it is enabled but no folder is selected, or when the page's
DevTools has not run yet. Popup tabs automatically use their opener's configured Local Overrides, including a
session's private folder. When overrides are enabled and a folder is selected, the popup starts native DevTools
in the background and applies matching overrides to its first response without displaying a DevTools panel or
reloading the page. POST submissions and opener callbacks are preserved. Disabled overrides remain disabled.
Hidden DevTools stays unthrottled and checks override readiness in its committed frame without waiting for the
entire frontend to finish loading, so a held popup document cannot block its own initialization.
If popup DevTools cannot initialize, its held response is released unmodified and the browser reports the
Local Overrides error instead of leaving the popup blank. A popup in its own window keeps its opener selected,
so the browser shows that popup's error under the address bar, named after the popup with ⧉, and marks its
page with ⚠; the error goes away when the popup closes. The CLI's browser status reports that error with the
popup's page id only, since page titles stay out of CLI metadata.
For the initial page or a page created with **+**, open **DevTools / Overrides** once; the warning has a button
for it. Overrides apply while that page's DevTools runs, shown or hidden. Once DevTools runs the
status comes from DevTools itself and follows changes within about a second; before that it comes from
the saved settings.

Use Network's **Override content** or **Override headers** actions, or edit the
existing files in your overrides folder. Save and reload to test the changes.
This uses native Chromium Local Overrides, including its URL-to-file mapping and
header override support. Overrides replace downloaded responses; they do not
automatically compile original TypeScript or modify your project's original
source files. Source-mapped files have Chromium's normal override limitations.
See [Chrome's Local Overrides documentation](https://developer.chrome.com/docs/devtools/overrides/).

**Console** and **Network** open the selected page's native Chromium panels.
Console includes filtering, JavaScript evaluation/history/autocomplete, object
inspection, stack traces, grouping, copy/save and live expressions. Network
includes filters, request payloads, response previews/bodies, cookies, initiators,
waterfalls/timing, recording and preserve-log controls, disable cache, network
throttling/offline, replay XHR, copy as cURL and HAR exports. These panels and
**DevTools / Overrides** fill the browser viewport. **Page** returns to the web app
without shrinking it; the same DevTools session and overrides remain alive when
switching views. Native Network starts collecting when that page's DevTools opens;
reload to capture requests that happened before inspection started.

**Activity** shows the captured logs used by Copilot CLI, including all pages in
the terminal. It has separate Console/Network logs, text and page filters,
console-level and request-type filters, failed-request filtering, request sorting,
repeat grouping, auto-scroll, individual/log copy, and JSON log export. Separate
**Clear console** and **Clear network** buttons clear one captured log without
erasing the other. **Pause capture** affects that captured log and **Preserve log**
controls whether its entries for a page survive that page's navigation. These
controls are independent of native DevTools' own recording/clearing settings.
Captured logs retain the latest 300 entries in memory and include `pageId` for
attribution, including entries from pages that have since closed. They capture
while native DevTools is open. Activity entries exclude request/response bodies
and WebSocket message frames. The assistant's separate response capture exports
filtered JSON bodies as described below; native Network retains its own capture.
Credential headers (including cookies, API keys, authentication, token and session
headers), sensitive URL query parameters, and URL fragments are redacted from
activity and CLI output. Console filtering handles recognizable credential fields,
Bearer values and URLs, but arbitrary console text and URL paths may still contain
application data or secrets. Avoid logging secrets in the app you debug. The address
field and native DevTools display the real page URL so navigation and overrides work.
Console and ordinary header text are capped at 8192 characters before filtering.
Oversized URLs and URL-bearing headers are replaced with a redaction marker so a
partial credential cannot escape filtering at the limit.

## Everyday browser controls

With the page focused (or the address toolbar, for find):

| Action | How |
|---|---|
| Zoom in, out, reset | **Ctrl+=**, **Ctrl+-**, **Ctrl+0**, or select the zoom percentage in the toolbar to reset. Steps follow Chrome (25% to 500%). |
| Find in page | **Ctrl+F** opens a find bar above the page with a match count; **Enter** / **Shift+Enter** (or **F3** / **Shift+F3**) step through matches; **Esc** closes it. Navigating to another page ends the search. |
| DevTools | **F12** or **Ctrl+Shift+I** toggles DevTools, like the DevTools / Overrides tab. |
| Address suggestions | The address field suggests pages you visited in this session, newest first (up to 200; nothing with a query string secret or a fragment, and not saved across restarts). |
| Right-click menu | Back, Forward, Reload, Hard reload, Select all, and **Inspect element** (opens DevTools on that element). On a link: **Open link in new page** and **Copy link address**; on an image: **Copy image address**; on selected text: **Copy**; in a field: **Cut / Copy / Paste**. Only HTTP(S) addresses are offered. |

The assistant's browser status does not include the address suggestions or the find text.

## Adding a page element to the prompt

Select the crosshair button in the address toolbar, then click an element in the page.
Chromium highlights what is under the pointer, and the click is consumed by the picker, so
it never reaches the web app. **Esc**, the same button, switching pages or leaving the Page
view cancels the selection, and it ends by itself after two minutes.

The element is described in a short text block that is **pasted into the session's prompt
box, not sent**: review or edit it, then press Enter. The block has the element's tag,
classes and id, a CSS selector that says whether it is unique, its visible text (up to 300
characters; text that is hidden, `aria-hidden`, `display:none`, `visibility:hidden`, fully transparent or without a rendered box is left out), a fixed allow-list of attributes (`id`, `class`, `role`, `aria-label`,
`data-testid`, `href`, `src`, `alt`, `title`, `type`, `name`, `placeholder`, `for`,
`disabled`), its position and size in the page, a few computed styles, and the chain of
parents. Without bracketed paste the block is joined onto one line with ` | `, so a line
break cannot press Enter for you.

**Several elements and a comment:** Shift+click the crosshair button. The picker stays on, each click
adds a chip above the page (up to ten; **×** removes one), and **Esc** ends the selecting. Type an
optional comment, then **Add to prompt** pastes the comment and every element block, numbered
"Element 1 of N", into the prompt box. Nothing is sent. Selecting several elements stops by itself after ten, or two
minutes without a click.

Privacy: only you can start a selection (it is a desktop action, not part of the
assistant's browser commands). Form controls and credential-marked elements show no value
or text, descendants that are form controls or credential-marked are left out of the text,
and recognizable credentials and URL secrets are filtered both in the page and again in the
app. The page itself is never given a handle to the element or the selection. Elements
inside cross-origin frames are not supported.

## Copilot CLI access

Local Copilot processes launched by Desktop receive browser diagnostic
instructions and a session-specific helper automatically. Ask **"Find any
exceptions in the browser console"** or **"Inspect failed network requests"** in
the terminal. Copilot can run the read-only helper through its existing shell tool;
no third-party MCP, Node installation, or desktop CLI installation is required.
Open a Browser tab and load the web app. Browser control automatically uses the current running session in that project.

To read the same data directly from a shell inheriting that session's environment:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:COPILOT_DESKTOP_BROWSER_HELPER" console
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:COPILOT_DESKTOP_BROWSER_HELPER" network
```

On macOS and Linux the helper is a shell script that needs only `sh` and `curl`. Every helper
command in this document works the same way: replace
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:COPILOT_DESKTOP_BROWSER_HELPER"`
with `sh "$COPILOT_DESKTOP_BROWSER_HELPER"`, and use absolute POSIX paths (such as
`/tmp/page.png` or `/tmp/plan.json`) where the examples use Windows paths. Copilot's own
browser instructions already use the form for its platform.

```sh
sh "$COPILOT_DESKTOP_BROWSER_HELPER" console
sh "$COPILOT_DESKTOP_BROWSER_HELPER" screenshot -OutputPath /tmp/page.png
```

The helper also supports `status` and `request <id>`. Its endpoint always belongs
to the session that launched the shell, regardless of the currently focused tab.
Within that session, `console`, `network`, and their `status` counts reflect only
the selected browser page. Switching pages changes the queried page without
discarding the other pages' captured activity.
Read `status` before inspecting logs: `recordingConsole` / `recordingNetwork`
indicate whether each captured log is recording, and `preserveConsole` /
`preserveNetwork` indicate whether a page's entries survive navigation. Copilot's
instructions require reporting paused capture or incomplete history alongside
the available observations. An empty retained log does not establish that the
web app has no exceptions or failed requests; logs can also be cleared or exceed
their retention limit.
If custom instructions are disabled in Copilot, run the helper explicitly.
Remote sessions execute tools on their remote computer and cannot read the local
Desktop endpoint. Restricted side chats retain their file-view/search permissions
and cannot execute shell commands.

With Node and the optional desktop CLI installed, the equivalent commands are:

```text
copilot-desktop browser status
copilot-desktop browser console
copilot-desktop browser network
copilot-desktop browser request 123
```

All commands return JSON. `request` uses an ID from the network list. During
repository development, use `node dist/src/cli/cli.js browser console` and the
equivalent commands after building if the `copilot-desktop` executable is not
installed on PATH. These commands use `COPILOT_DESKTOP_BROWSER_STATE` inherited
from their terminal session. An external shell must explicitly set that variable
to the desired session's endpoint; it does not select whichever browser is focused.

Each session owns a private loopback API with a random bearer token saved in its
private Desktop session directory. On Windows that folder stops inheriting profile
access and grants the signed-in user, SYSTEM and Administrators only; the only
documented caller of the helper and `control.json` is that session's own shell,
running as the same user. It accepts no browser Origin requests and exposes
no arbitrary JavaScript, CDP, storage, credential or file-write routes. Test plans
bind navigation to the selected HTTP/HTTPS page’s origin for each run. No enable toggle is required.
Constrained browser reading actions use the same authenticated transport. It is independent of the background CLI
daemon; `copilot-desktop start` is not required. Desktop assigns the endpoint
path to its session's `COPILOT_DESKTOP_BROWSER_STATE` environment variable;
independent Desktop launches and their terminal tabs use different paths.

The same button, now labelled **Hide browser**, hides the pane and keeps its page, DevTools state, and capture
alive until the owning terminal session closes or the app quits. The **DevTools / Overrides** button toggles DevTools
visibility and keeps enabled overrides active while it is hidden. Browser pages have no desktop preload
bridge or Node integration. New pages accept HTTP/HTTPS and initial blank pages;
local files and other external protocols and downloads are blocked, and so are permission requests,
except the three described under *Site permissions* below.

## Page dialogs

`alert()`, `confirm()` and the leave-page prompt (`beforeunload`) hold the page until they are
answered. The browser pane shows the page's message with **OK** / **Cancel** (**Leave** / **Stay**
for a leave-page prompt) above the page, and the dialog text is filtered for credentials. While a
dialog is open the assistant's reads fail at once with a message that says a dialog is waiting for
you, instead of timing out. `prompt()` is not supported by the Electron browser engine, so pages
that call it receive no answer.

In an automated test a step that triggers a dialog declares it, for example
`{ "action": "click", "selector": "#delete", "dialog": { "accept": true, "message": "Delete item" } }`.
`dialog` is accepted on `click`, `doubleClick`, `press`, `fill`, `select` and `navigate`; `message`
must be contained in the dialog's text. The dialog is answered during that step (it may open up to
1.5 seconds after the action), and the report's step `detail` records its type, text and answer.
A dialog that no step expected is dismissed and the test fails with its text; a step that declares a
dialog that never opens fails too. Run a plan twice, with `accept` true and false, to cover both
outcomes of a `confirm`.

## Adding a screenshot or console errors to the prompt

Two more buttons in the address toolbar put context into the session's prompt box. Nothing is
sent: review the prompt, then press Enter.

- **Camera**: captures the selected page's viewport, masked exactly like an assistant screenshot
  (form controls, credential-marked elements, frames and canvases are covered), puts the PNG on the
  system clipboard, and attaches it with Copilot's Alt+V shortcut. The clipboard is replaced by the
  image. The Page view must be showing and the window visible.
- **Console**: adds the page's console errors and warnings (or its latest messages when there are
  none) and failed requests (HTTP 400 and above, or a network error) as text. Entries are the
  filtered ones the browser already captured, limited to 25 console lines and 10 requests.

## Sharing between projects

Each project has one browser: its pages are used by every session of that project, and browser
control follows the project's current session. Like tabs in one Chrome profile, every project's
browser shares:

- address-bar history (Settings → **Project browsers** → **Clear browsing history** empties it),
- [site permissions](#site-permissions),
- page zoom per site.

All of these are kept across app restarts, whichever cookie setting you choose. DevTools settings
and the Local Overrides folder follow each project's Local Overrides choice (see above). Each
page keeps its own console and network capture.

Cookies, logins, local storage, IndexedDB and cache depend on Settings → **Project browsers** →
**Cookies, logins and site storage**:

- **Separate for each project** (default): each project has its own cookies and site storage,
  so signing in to a site in one project does not sign you in elsewhere. Closing tabs or CLI
  sessions keeps your logins. Removing a workspace closes its browser and forgets its profile,
  so adding it again starts with fresh logins. The old profile's cookies and site storage stay
  on disk until the next app start deletes them, and stay longer while a settings recovery is
  pending.
- **Shared by all projects, like Chrome**: every project uses one profile, so signing in once
  signs in everywhere, including for the Copilot agent in each session. **Clear shared browser
  data** signs every project out and removes its cookies, site storage and cache.

Changing the setting applies to browsers opened afterwards; an open browser keeps its profile
until all its project's pages close or the app restarts.

## Site permissions

A page can ask to copy text to your clipboard (`navigator.clipboard.writeText`), read text from
your clipboard, or show notifications. A native dialog names the site and the request; **Allow**
or **Block** is remembered for that site and permission in every project's browser and kept
across app restarts. Open **Site permissions** at the bottom of the browser pane to see the
answers and **Forget** one (or all), after which the page is asked again.

Everything else (camera, microphone, location, screen capture, USB and other devices, fullscreen
and so on) is always blocked without a prompt. Only the page's top frame can ask: requests from
embedded frames are blocked, as are `file:`, `data:` and other non-HTTP(S) pages. Dialogs are
queued one at a time, and a request from a page that closes while the dialog is open remembers
nothing. The assistant cannot answer a prompt, and the list of answers is not part of the
assistant's browser status.

## Certificate warnings

When a page's certificate cannot be trusted, for example `ERR_CERT_COMMON_NAME_INVALID`, the browser
pane shows a warning in place of the page, with the reason and **Go back**. To continue anyway, open
**Advanced**, check the certificate's details and choose **Proceed**. A page in its own popup window
shows its warning in the browser pane, above the selected page.

**Proceed** is offered only for a wrong name, an expired certificate or an unknown issuer
(`ERR_CERT_COMMON_NAME_INVALID`, `ERR_CERT_DATE_INVALID`, `ERR_CERT_AUTHORITY_INVALID`). Every other
certificate error, such as `ERR_CERT_REVOKED`, shows the warning with **Go back** only.

Proceeding accepts that certificate, for that host and that error, until the app quits. Every page in
the same browser profile uses it, including when the assistant uses the browser, and the toolbar shows
**Not secure** for that host. A different certificate or a new error warns again. Images, scripts,
frames and other resources with an untrusted certificate never ask: they fail unless you already
accepted that certificate through a page.

The warning is drawn by the app, so a website cannot answer it. The assistant cannot answer it either:
it sees the error in the browser status, without the warning. Unlike Chrome, the browser cannot tell
whether a site requires HTTPS through HSTS, so **Proceed** is offered on those sites too.

## Reading authenticated Jira tickets and other pages

Ask the session's Copilot **"Read this Jira ticket, including its comments and linked
issues"** after loading it in that project's Browser tab and signing in normally.
The browser's existing permissions and login apply; the assistant never exports
cookies or tokens, makes extra authenticated requests, or replays captured requests.
No third-party MCP is required. Instructions are installed for newly started local
Copilot processes; existing processes can run the updated helper explicitly.

The installed-app helper and optional desktop CLI support:

| Command | Result |
| --- | --- |
| `tabs` | This session's page IDs, sanitized URLs, loading state and selection |
| `select PAGE` | Select an existing browser tab in this session |
| `frames [PAGE]` | Frame IDs, parents and sanitized URLs, including cross-origin children |
| `snapshot [PAGE] [FRAME] [OFFSET]` | Current rendered text and a filtered DOM tree with tags, roles, names, parent relationships, link URLs and control references; `nextOffset` reads later chunks |
| `scroll PAGE FRAME PIXELS [SNAPSHOT NODE]` | Scroll the document or a referenced container by up to 2000 pixels |
| `screenshot [PAGE]` | Masked viewport PNG and metadata |
| `responses [PAGE]` | Captured response IDs, page/frame attribution, status, timestamp and availability |
| `response BODY_ID` | One filtered JSON response, without replaying the request |
| `activate PAGE FRAME SNAPSHOT NODE` | Activate a referenced application control **only after native user approval** |

For example, in a shell inheriting the terminal session's environment:

Omit the page ID to read the currently selected browser page. This applies to
`frames`, `snapshot`, `screenshot`, and `responses`. Explicit page IDs remain
available for targeted reads and pagination; the assistant should not select a
different page unless asked.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:COPILOT_DESKTOP_BROWSER_HELPER" tabs
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:COPILOT_DESKTOP_BROWSER_HELPER" snapshot
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:COPILOT_DESKTOP_BROWSER_HELPER" frames
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:COPILOT_DESKTOP_BROWSER_HELPER" responses
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:COPILOT_DESKTOP_BROWSER_HELPER" screenshot -OutputPath "$env:TEMP\ticket-new.png"
```

The optional CLI equivalents use `copilot-desktop browser COMMAND ...`; saving a
screenshot uses `copilot-desktop browser screenshot C:\Temp\ticket-new.png`. Screenshot
files are written by the caller's shell, never by an HTTP file-write route, and an
existing file is not overwritten. Output filenames must be local absolute `.png`
paths; UNC shares, device paths and other extensions are rejected. Without an output
filename the screenshot command
returns PNG base64 in JSON. Save and view the PNG instead of printing its base64.
Restore and show the browser window to capture a screenshot; minimized or hidden
windows report `unavailable`. Text snapshots remain available while minimized.
Screenshots are withheld if the page cannot confirm painting promptly or the
protected layout changes during capture. Wait for the page to settle and retry.

Snapshots use a fixed function in a Chromium isolated world. They do not export raw
HTML, arbitrary attributes, scripts, styles, hidden content, form values, cookie or
storage data. The DOM includes accessibility roles/states supplied by the page; it
is not a complete native Chromium accessibility tree. Open shadow roots are inspected;
closed shadow roots are unavailable. Embedded frames are read through separate frame
snapshots. No page-provided JavaScript expression or selector can be submitted.

Read snapshots again after loading, scrolling or activation. This handles dynamic
ticket descriptions, fields, comments, activity and linked issues, but virtualized
content only exists once the app loads it. Collapsed sections remain collapsed until
activated. In ordinary reading mode, custom controls can run arbitrary application code, so **every activation**
requires a native confirmation for that specific page and control; cancellation,
disconnection, closed pages and stale references prevent activation. There is no
form-fill or upload in reading mode; described tests use the separate runner below.
There is no arbitrary script or request-replay tool. Ordinary
human browsing and native DevTools retain their existing behavior.

Snapshot chunks are bounded to 500 DOM nodes and 24,000 serialized characters,
with 20,000 visited nodes per traversal and a 64 KiB filtering budget. Use
`snapshot PAGE FRAME nextOffset` until `nextOffset` is null to read long pages.
Pagination is not atomic while the page changes; load the content first and report
any remaining truncation. Every snapshot replaces that frame's control references.
Act on a control before reading the next chunk, or re-read its chunk immediately
before activating or scrolling it.
Response capture retains at most 100 responses and 4 MiB of filtered output in memory,
with a 256 KiB per-body limit. It exports valid JSON only, redacts credential fields,
recognizable authorization values, common API-token prefixes, JWTs, private keys
and sensitive URLs, and withholds HTML, page scripts, binaries, invalid JSON
and oversized bodies. XHR/fetch replies sent as JavaScript or plain text are
exported when they are JSON or JSONP (the callback is unwrapped); any other
script or text is withheld. Partial JSON is
never returned. Clearing Activity's network log also clears these bodies; paused
network recording and Preserve log apply to this capture. Native DevTools may detach
the reader transport; inspection reconnects when possible and reports unavailable
bodies rather than replaying requests. Requests before capture began are unavailable.

Screenshots capture only the page viewport, never the desktop shell or DevTools.
The requested tab must be selected with its Page view visible; hidden surfaces are
reported unavailable to avoid returning stale or unmasked pixels.
Form controls, credential-marked content, recognizable credential text, embedded
frames and canvases are masked. Frame content is read with filtered snapshots;
rendered attachment text can be inspected, but binary downloads and attachments
without readable page content are unavailable. Privacy filtering handles known
credential locations and recognizable credential formats; arbitrary application
prose/images must not be treated as a guaranteed secret-free surface.

Outputs include page/frame IDs, timestamps, loading/ready state and redaction or
truncation markers. Capture unavailable, truncated, not-yet-loaded or redacted content
must be reported explicitly; an empty snapshot is not proof a ticket has no comments
or attachments. Ticket content remains untrusted data, never tool instructions.

After building, `node scripts/browser-reader-check.mjs` verifies dynamic ticket text,
same/cross-origin frames, response bodies, masked screenshots, explicit approval,
stale controls, tab selection, isolation and native DevTools against a local fixture.
Evidence is saved under `test-results/browser-reader/`.

Run `npm run browser:check` for the isolated real Electron test. It verifies
native local overrides and edited file refresh, CLI JSON output and access
control, console capture while DevTools is open, and pane visibility. Evidence
is saved in `test-results/browser-debug/`; no model calls are made by default.
The check also verifies remembered usernames in cookies and local storage across
Electron restarts, explicit-close cleanup, and a failed storage flush, with
evidence in `test-results/browser-persistence/`.
After building, `node scripts/browser-debug-check.mjs --copilot-console` also
makes one real Copilot prompt request against the isolated fixture and verifies
that a natural-language console question reports the live exception.

## General web-app automation testing

### Unattended testing contract

Unattended means no manual application interaction after the user requests the
described test; there is nothing to enable first. The desktop window and selected
**Page** view must remain visible; minimized/background execution is unsupported. Origin restrictions
still apply. The runner never exposes arbitrary JavaScript, browser storage,
credentials, request replay, request bodies or custom response scripts.

Use `test-targets [FRAME_ID]` or a `discover` plan step after opening a menu,
hovering a control, or changing the application. Discovery returns page/frame IDs,
a generation, timestamp, CSS-pixel bounds, accessible names, title/tooltips, roles,
selected/expanded/disabled states, suggested selectors and `selectorUnique`.
Nonstandard div/span controls with pointer cursors, handlers, titles or accessibility
attributes are included. `unavailable` describes hidden candidates without hidden
labels. `reason` explains disabled, offscreen and center-covered controls. Coverage
is sampled at the visible center; coordinate input always checks its actual point.
Results are bounded to 200 visible targets and 50 hidden candidates. Closed shadow
roots and controls beyond the traversal limit remain unavailable. Discovery makes
one traversal of at most 30,000 elements, caps stored candidates, and reports
`inspection.visited` and `inspection.complete`. Explicit controls take priority
over generic leaf div/span candidates. Selector uniqueness is conservative: hidden
duplicates count too, and an incomplete traversal cannot establish uniqueness.
Opacity-zero controls remain available for native input and assertions (as used
by styled checkboxes); discovery reports them as transparent. Native hit-testing
still determines whether they can receive input. Private controls and controls
under a `data-private` ancestor, including shadow hosts, mask both names and titles.

When a selector is ambiguous, use `targetRef` from that frame's latest discovery:

```json
{ "action": "click", "targetRef": "0123456789abcdef0123456789abcdef-t3" }
```

Supply either `selector` or `targetRef`. References are bound to the page, frame,
document and discovery generation; another discovery in that frame invalidates
the old generation. Reload invalidates references even when cancelled. Removed or
replaced elements fail as stale rather than being resolved to a replacement. Use
the returned `frameId` as `frame` for child-frame actions. Targets are revalidated
for identity, visibility, enablement and native hit-testing before input.

`click`, `doubleClick`, and `hover` accept `point: {x,y}` in the same CSS-pixel
coordinate system as drag paths. All pointer actions support canvas and SVG.
`inputSelector` or `inputRef` can explicitly identify a separate interaction
overlay; click/hover overlays require `point`. Coordinates stay relative to the
primary target, never the backing-store dimensions. Browser zoom and display
scaling are reflected in discovery and pointer diagnostics; fractional native
positions can differ by about one CSS pixel. Input never bypasses a covering
element or accepts a broad ancestor as an overlay.

```json
{ "action": "doubleClick", "selector": "#image", "inputSelector": "#overlay", "point": { "x": 140, "y": 70 } }
```

Pointer actions support `button` (`left`, `middle`, `right`, default `left`). Pointer
actions and `press` support unique `modifiers` from `Alt`, `Control`, `Meta`, `Shift`.
Drag performs movement, button down, intermediate moves and button up within one
bounded action (2–100 points, 100–5000 ms). Buttons/modifiers are released on
completion, errors and cancellation; no held input crosses plan steps. Target
replacement, obstruction or geometry movement fails safely with hit diagnostics.
Modifiers apply to drag too, for tools that change behaviour while a key is held,
such as Ctrl+drag to window/level or Shift+drag to constrain a line. Assert the
resulting value afterwards:

```json
{ "action": "drag", "selector": "#image", "modifiers": ["Control"], "path": [{ "x": 40, "y": 40 }, { "x": 140, "y": 90 }] },
{ "action": "assert", "selector": "#window-level", "condition": "text", "expected": "W 400" }
```

`wheel` sends native wheel events to a target point: `deltaX` and/or `deltaY`
(integers within ±1000 CSS pixels per event, at least one nonzero), `repeat` (1–20
events, default 1), and the pointer fields of `hover` (`point`, `inputSelector`,
`inputRef`, `modifiers`). The page sees trusted `wheel` events with the held
modifiers, as when scrolling an image stack or Ctrl+wheel zooming a viewer. Before
each event the point is hit-tested again; if the target moved, scrolled away or was
covered, the step fails with `data.geometry.phase` `between wheel events` and
`eventsSent`, and no further event is sent. Wheel on the scrolling container or the
canvas, not on an item that scrolls with it. `data.wheel` reports the events sent.

```json
{ "action": "wheel", "selector": "#viewport-1", "deltaY": 120, "repeat": 3, "modifiers": ["Control"] }
```

`press` accepts the named keys above and single letters `a`–`z` and digits `0`–`9`
for application shortcuts. A letter or digit types its character only without
`Alt`, `Control` or `Meta`, so `Control`+`s` is a shortcut and never inserts text;
`Shift` changes letters only. Chords the browser handles itself are refused:
`Control` or `Meta` with `w`, `t`, `f`, `g`, `r`, `i` or `0` (close, new tab, find,
reload, DevTools, zoom). Use `reload` and the other test actions instead.

A page-level shortcut uses `"scope": "page"` instead of a target: the key goes to
whatever has focus, and `data.keyboard.focus` reports that element (tag, id, classes
and role; never its value) or `document body`. It refuses when focus is inside a
frame, where the key would reach another document; press on an element in that
frame instead.

```json
{ "action": "press", "scope": "page", "key": "s", "modifiers": ["Control"] }
```

`reload` is independent of F5/Ctrl+R. It waits for navigation and reports
`navigation: completed|cancelled`, `loading`, and `testingEnabled`, plus fresh target
discovery. Declare `dialog: {accept:false}` to cancel a leave-page prompt. To wait
for application readiness after navigation, supply `all`:

```json
{
  "action": "reload",
  "timeoutMs": 30000,
  "all": [
    { "selector": "#viewer", "condition": "attribute", "attribute": "data-test-render", "expected": "ready" },
    { "selector": "#loading", "condition": "hidden" },
    { "selector": "#save", "condition": "enabled" }
  ]
}
```

`waitFor` and `assert` also accept `all` (1–10 conditions) instead of one condition.
Every condition must hold in the same polling pass; observations across frames are
sequential, not an atomic application snapshot. Additional conditions are `enabled`,
`attribute` (public `data-*`, `aria-*`, `role`, `title`, `class`),
`numericValue` (`expected` number, optional nonnegative `tolerance`, default zero)
`stable` and `visualStable`. An application can publish its own state in `data-*` attributes
(for example `data-grp="g"` on a link-group chip) and the plan can wait on or
assert it directly, instead of encoding the value in a CSS selector.

`stable` waits until one visible element's bounds (x, y, width, height) have stayed
within `tolerance` CSS pixels (0–50, default 0.5) for `stableMs` milliseconds
(100–5000, default 500). Samples are taken on the runner's normal polls and kept
per run step and condition, also inside `all`. A replaced element, a new document
or a hidden element starts the window again. The window must be shorter than the
step's timeout. Use it before clicking a control that moves while the layout
settles:

```json
{ "action": "waitFor", "selector": "#tool-link", "condition": "stable", "stableMs": 300 }
```

`visualStable` waits until the *pixels* of one top-frame element, or of a viewport
`region`, stop changing. `stable` only watches an element's position and size, which
stay the same while a viewer refines its image inside a canvas: low resolution first,
then full resolution as slices and tiles arrive. Use `visualStable` before a
comparison or a screenshot when the app has no ready signal of its own.

```json
{ "action": "waitFor", "selector": "#viewport-1", "condition": "visualStable",
  "stableMs": 750, "imageTolerance": { "channel": 4, "maxDiffRatio": 0.001 }, "timeoutMs": 20000 }
```

- On each of the runner's polls (about every 150 ms plus the capture) the area is
  captured the same way test screenshots are, with canvases included and masks
  applied, and compared with the previous capture.
- It passes once the area has stayed within `imageTolerance` for `stableMs` (100–10000,
  default 750), which must be shorter than the step's timeout. `imageTolerance` and
  `ignore` work as for `compareScreenshot`; the defaults allow no change at all.
- The window starts again when the element is replaced, moves or is resized, when the
  capture size changes, or when a capture is unavailable (for example while the page
  is hidden). It takes no `frame`.
- `data.visualStable` reports the window, the number of captures, how long the area
  was unchanged, and the last change seen (its pixels, ratio and bounds in CSS pixels).
  On a timeout the reason names the last change and the longest still stretch.
- Only the latest capture is kept, and only for the current step.
- A page that keeps animating inside the area, such as a playing cine loop or a
  spinner, never settles: stop the animation first, or `ignore` the spinner. An
  animation that returns to exactly the same pixels between two captures can look
  still, because captures are a few hundred milliseconds apart.
Numeric checks read visible field values or numeric element text without exporting
the value. Content assertions (`numericValue`, `value`, `text`, `attribute`) refuse
private regions, aggregates containing private content, password fields, and
autocomplete fields for passwords, one-time codes or payment details. This also
prevents repeated numeric-range assertions from disclosing protected values.
Text target filters also exclude these protected elements and private aggregates
before reading their text, including for visibility and count assertions or actions.
Use a public application-state indicator for assertions instead.

A `consoleMessage` condition takes `expected`, an anchored glob in which only `*`
is special (`"viewer ready*"`, `"*state: 3 frames*"`), an optional `level`
(`debug`, `info`, `warning`, `error`) and no target. It passes once the test page
has logged a matching message during this run, even while console recording is
off; messages from earlier runs never count. Because any match in the run counts,
include a revision or the state itself in the logged text when the same message
can appear more than once:

```json
{ "action": "waitFor", "condition": "consoleMessage", "expected": "viewer ready*", "level": "debug" }
```

Set `"failOnConsoleError": true` on the plan to fail a run when the test page (or
a same-origin frame) logs a console error, including an uncaught exception or a
failed resource load. `consoleErrorIgnore` takes 1–20 globs of known errors to
ignore, such as `["*CanvasTextAlign*"]`. The error fails the step during which it
arrives: a wait stops at its next poll, an action finishes delivering first (its
`delivery` is kept), and the remaining steps are skipped; the step is never
retried. The failed step's `data.consoleErrors` lists up to 20 errors, repeats
counted. Console messages reach the runner asynchronously, so an error caused by
one step can arrive during the next. Errors are watched as they arrive, whether or
not the console is being recorded; messages from workers, and from after the last
step, are not observed.

Each step result carries `console: {entries, total, truncated, complete}` when the
page logged anything during the step: up to 10 messages, errors kept first, each
message cut to 500 characters, with consecutive repeats kept once with a `count`.
`complete` is false when a message in the step was not recorded (recording off),
or was evicted or cleared. The run's `evidence.console` keeps up to 100 entries
the same way, and `evidence.capture.consoleComplete` says whether the whole run
was recorded. Each page keeps at most 300 console entries and all pages together
1000, so one page's flood cannot evict another page's messages; closed pages are
evicted first.

A `requestComplete` condition takes
`request: {urlPattern,method,state:"finished"|"failed",optional status,optional minCount}` and no target.
It matches requests observed during this run, never an earlier run. `minCount` (1–1000,
default 1) waits until that many matching requests have reached the state, for example
every frame of a series; a timeout reports how many did, and the step's
`data.requests` gives the count. The latest 2000 requests of a run are kept for
matching; reports list the latest 100.

Combine network completion with application signals for the current render revision.
A completed request, changed label, animation frames, decoded image or nonempty
canvas cannot prove that asynchronous rendering has finished. Use explicit
`discover` and `screenshot` steps for fresh after-action observations and before/after
evidence, following readiness waits. Screenshots can be cropped to a region or an
element. A `compareScreenshot` step compares a capture with a reference PNG (see
*Comparing with a reference image* below); other saved screenshots require separate
visual inspection. Visual differences must never be presented as proof of
application semantics.

### Timing and memory

A `measure` step times how long something takes, and can fail when it takes too long.
An interval runs `from` an earlier step (`{ "step": 1 }`, its `end` by default or its
`"at": "start"`) or from the first console message matching a glob
(`{ "consoleMessage": "study requested*" }`), `to` a wait condition, polled until it
holds (`timeoutMs` up to 60000, default 30000):

```json
{ "action": "click", "selector": "#open-study" },
{ "action": "measure", "name": "first image", "from": { "step": 1 },
  "to": { "selector": "#viewport-1", "condition": "attribute", "attribute": "data-render", "expected": "done" }, "maxMs": 2000 }
```

- The time is taken by the runner, so the page needs no cooperation. A polled condition
  is reported as `ms` (when it was seen to hold) and `atLeastMs` (the last poll that saw
  it false, or the start). Polls are about 100 ms apart, so put the measure step right
  after the step it starts from. If the condition already held when the measure began,
  the interval is only bounded by the start.
- A `consoleMessage` end condition is timed by when the first matching message after the
  start arrived in the desktop, so `ms` and `atLeastMs` are equal.
- `maxMs` (1–600000) makes the step an assertion: it fails when `ms` is over the limit.
  Without it, the step only observes.

A rate counts console messages matching a glob over a window, for cine playback or
animation:

```json
{ "action": "measure", "name": "cine", "rateOf": { "consoleMessage": "frame shown*", "level": "debug" },
  "windowMs": 3000, "minPerSecond": 15 }
```

`windowMs` is 100–30000; `minPerSecond` and `maxPerSecond` make it an assertion. The
messages are counted whether or not console recording is on.

A `metrics` step reads the page's JavaScript heap (`jsHeapUsedMb`, `jsHeapTotalMb`) and
its DOM counts (`nodes`, `documents`, `listeners`), after a garbage collection unless
`"collectGarbage": false`. With `since` (an earlier `metrics` step's number) it reports
the growth, and `maxHeapGrowthMb` and `maxNodeGrowth` fail the step when growth is over
them. This catches a viewer that keeps memory after a study is closed:

```json
{ "action": "metrics" },
{ "action": "click", "selector": "#open-study" },
{ "action": "click", "selector": "#close-study" },
{ "action": "metrics", "since": 1, "maxHeapGrowthMb": 10, "maxNodeGrowth": 500 }
```

Readings cover the page's main JavaScript world and its same-process frames. Every
measurement and reading is also listed in the report's `measurements`, with its step
number. Timings depend on the machine, on what else it is doing and on whether the
page is visible, so set generous limits and compare runs on the same machine.

### Opt-in network failures and recovery

A plan may set `allowNetworkFailures: true` and 1–8 `networkFailures`. Each rule
requires a user-approved `urlPattern` (literal enabled origin, `*` wildcard in path,
no credentials/query/fragment), uppercase `method`, `failure: transport|http`,
`maxRequests: 1–20`, and `durationMs: 100–60000`. HTTP errors additionally require
`status: 400–599`; arbitrary bodies/headers are not accepted. For example:

```json
{
  "allowNetworkFailures": true,
  "networkFailures": [
    { "urlPattern": "http://localhost:3000/api/save", "method": "POST", "failure": "http", "status": 503, "maxRequests": 1, "durationMs": 10000 }
  ]
}
```

`failure: "delay"` holds each matching request for `delayMs` (100–30000), then lets
it continue unchanged, to test what the app does while data is still arriving: scrolling
to a slice that has not loaded, a cancelled load whose reply comes late, or a stalled
progress bar. Delay rules take no `status` and allow `maxRequests` up to 200, for the
frames of a series. When the run ends, fails or is cancelled, any request still held is
let through at once. Each affected request records its `delayMs` and when it was
`released` (`after delay`, `rules ended` or `run ended`).

```json
{
  "allowNetworkFailures": true,
  "networkFailures": [
    { "urlPattern": "http://localhost:3000/dicomweb/studies/*", "method": "GET", "failure": "delay", "delayMs": 3000, "maxRequests": 20, "durationMs": 30000 }
  ]
}
```

A plan can also slow the whole page for the run with `networkConditions`:
`latencyMs` (0–10000), `downloadKbps` and `uploadKbps` (16–1000000 kilobits per second;
an omitted direction is not throttled), and `offline`. A slow network needs no opt-in;
`offline: true` requires `allowNetworkFailures: true`. The conditions apply to the
selected page through Chromium's network emulation from the run's start, and are
removed when it ends, fails or is cancelled; if removal fails, the debugger is detached
to remove them. `evidence.network.networkConditions` records what was applied and whether
it was removed. Out-of-process frames, other pages and service workers are not
throttled.

```json
{ "networkConditions": { "latencyMs": 200, "downloadKbps": 2000, "uploadKbps": 500 } }
```

Rules intercept requests only in the selected page's known same-origin frames,
never another page or a shared browser storage Session. New out-of-process frames
are not enrolled. Rules expire, stop at their request limit, and are removed when
the test ends, fails, disconnects or is cancelled. If removal fails, the debugger
is detached to remove interception. Affected request metadata and cleanup status
are recorded. Service workers/caches can bypass interception; a test must assert
that the intended request was affected. Transport/HTTP failures cannot reproduce
every server-side partial-success scenario.

Reports retain legacy step `status` and separately identify `outcome` as `delivered`,
`assertion-passed`, `assertion-failed`, `observed`, `failed`, `skipped`, `cancelled`
or `uncertain`. `delivery` distinguishes `not-attempted`, `partial`, `delivered`
and `uncertain`. A delivered drag can be followed by a failed assertion; delivery
does not establish application change. A screenshot outcome means pixels were
captured, not visually approved. Capture failures are failed checks with reasons.

`status` exposes `testing.runId`, `currentAction` (step ID/action/delivery),
`lastCompletedAction`, and the incremental `journal`. `journal.completed` is false
while it is in progress; `report` retains the last completed run so progress cannot
resize the browser viewport. Polling status remains available during a run.
After HTTP transport loss, inspect these fields before issuing another save or
other mutation; uncertain or partial delivery must not be blindly retried. The
journal is in memory and cannot establish recovery after a desktop process crash.

Final reports include bounded run-specific request metadata, affected requests,
console evidence, capture limitations and pointer/hit diagnostics. Bodies, headers,
storage and credentials are excluded; known credentials and supplied input values
are filtered. Arbitrary application prose/images can still contain sensitive data.
Screenshots and comparisons remain explicit plan steps (at most five together), and
files are never overwritten. Report skipped/cancelled/unavailable checks and human visual inspection
separately; do not mark an unverified application expectation passed.

Run `npm run browser-unattended:check` for the isolated generic toolbar, hover menu,
modal numeric input and overlay-canvas acceptance page. It covers reload/cancel,
references, drawing, handle movement, ineffective input, readiness, network-failure
isolation/cleanup and recovery, at zoom factors 0.8, 1, 1.25, 1.5 with host display
scaling and forced 1.25 scaling. Evidence is under `test-results/browser-unattended/`.
This fixture uses synthetic data and does not contact shared application services.
`npm run browser-discovery:check` additionally verifies large-page discovery,
transparent input controls, private tooltips and sensitive-value assertion guards
through the production helper, with evidence under `test-results/browser-discovery/`.

1. Open the web app in the project's browser and select the page to test.
2. Tell the session assistant the steps, inputs, and expected results. For example:
   “Search for ITEM-42, open its details with a double-click, and verify that the
   title is ITEM-42 details, the preview has loaded, and no error banner appears.”
3. The assistant inspects the page, creates and runs a test plan, checks your
   expectations, and reports passed, failed, and skipped checks with evidence.

This works with general web apps. There is no viewer-specific workflow. Existing
login and storage are reused. The assistant receives test instructions when a
local CLI session starts; start a new CLI session after updating Desktop to load
the new guidance. You provide the test description; the assistant prepares the
structured plan. A user does not need to write selectors or JSON manually.

Tests are ready automatically on the current visible HTTP(S) page. The user's
request defines the test's scope; there is no enable toggle or confirmation per
step. Progress and **Stop test** appear in the existing footer during a run.
Stopping cancels that run; it never restarts automatically. Selecting, creating,
or closing the active page, hiding the pane, or selecting another browser view
also stops the run. A later requested test can start without enabling anything.
Each run binds navigation and input to its starting page and HTTP(S) origin;
other destinations and cross-origin frame inputs fail. Main-page navigation and
redirects outside that origin are blocked during a run; embedded third-party
frames may load and redirect for read-only inspection. To test another site,
open the intended site and start a separate test there.
A popup that opens as a tab changes the selected page and stops the old run; a popup window
leaves the selected page and the run alone.
A run stops at its first failed step. Test actions may change the app's data; a
failed or cancelled run does not undo completed steps. Keep the Page view visible
for input and screenshots. A run acts only on its own session's pages.

The runner supports navigation, click, double-click, hover, coordinate dragging, HTML5 drag-and-drop between elements, text entry and replacement,
single-choice select elements, keyboard keys and page-level shortcuts, document/container scrolling, native wheel input, waits,
assertions, screenshots, and comparisons with a reference image. CSS selectors plus optional visible text identify
targets. Exactly one visible enabled target is required for input. Covered targets
are rejected. Pointer actions recheck the target after hover-driven layout changes
and stop if the element is replaced or does not stabilize.

When the target moves, the failed step's `data.geometry` names the phase in which
the change was observed: `pre-press settling` (the pointer was moved over the target
for 2 seconds and it never settled; no button press was sent), `pointer settling`
(the same for `hover`, which sends no press), `after press` (the
button was released away from the target, so no click fires), or
`between double-click presses` (the first click was delivered, the second press
was not sent). It also lists the changed fields, the point, target and input
bounds before and after, and the delivery state. The phase says only when the change
was seen, not what caused it: a mousedown handler, a timer and an animation all look
the same. Such a step is never retried automatically. For layout that is still
settling, add a `stable` wait before the step. For a target that moves in response
to the press itself, assert the resulting state instead of clicking it twice. Open shadow roots and
same-origin HTTP(S) frames support input; cross-origin frames support read-only
inspection and assertions. Use current frame IDs from `frames`. Opaque/sandboxed
frames and frames with non-HTTP(S) URLs cannot receive test input.
Closed shadow roots, rotated/skewed frames,
uploads, downloads, file drops, custom DataTransfer content, and arbitrary JavaScript are unavailable.
Reference images for `compareScreenshot` are read by the helper, not uploaded to the page.

For drawing, canvas panning, or moving an item within a surface, use `drag` with a
unique `selector` and a `path` of 2–100 `{ "x": number, "y": number }` points. Each
point uses CSS pixels relative to the target's bounding-box top-left, rather than
screen coordinates or the canvas backing-store resolution. `test-targets` exposes
CSS-pixel bounds to help choose points. Points must remain within the target and
visible viewport; the entire canvas or input surface need not fit onscreen.
The runner preserves an already visible starting point, scrolls if needed before pressing, then
holds the selected native mouse button (left by default) while interpolating the path. `durationMs`
defaults to 500 and accepts 100–5000 milliseconds; event processing can extend the
elapsed time. Covered, moved, replaced, or navigated targets stop the drag. The
button is released on completion, failure, cancellation, or page switching.
Same-origin frame coordinates are mapped into the selected page automatically.
At fractional display scaling, native input is quantized to physical pixels, so
the delivered position can differ from the requested point by about one CSS
pixel. Assert the resulting app state; checks of delivered pointer coordinates
should allow a one-CSS-pixel tolerance rather than require exact equality.
Display scaling and browser page zoom are separate settings.

```json
{ "action": "drag", "selector": "#canvas", "path": [{ "x": 20, "y": 20 }, { "x": 80, "y": 40 }, { "x": 240, "y": 90 }], "durationMs": 500 }
```

Viewers often receive pointer input on an HTML or SVG overlay above the image.
Use that actual input surface as `selector`, or add `"inputSelector": "#viewer-input"`
to keep path offsets relative to the image selected by `selector`. The input surface
must match exactly one visible element in the same frame. Native hit-testing must
reach that surface or its descendants at every point. Neither hit-testing nor page
styles are changed; unrelated covers still block the drag. Both elements are checked
for replacement and changing geometry while the pointer is held.
An input surface cannot be an ancestor of the image target (including across shadow
roots); select the surface itself instead of a broad page or viewer wrapper.

An obstructed drag reports the path point (or segment and interpolated sample),
viewport coordinates, and the hit element's tag, ID, classes and role. Field values,
element text and accessible labels are excluded. Embedded-frame obstructions report
coordinates in the embedding viewport. A failure releases the pointer and skips
remaining actions.

Include an assertion of the app's resulting state after the drag. Painting a
canvas alone does not prove the intended selection, drawing, or pan succeeded.

`drag` is for pointer gestures. If its path starts an HTML5 drag from a
`draggable` element, the step fails and asks for `dragTo`, and the drag is
cancelled, so no operating-system drag follows the real cursor.

To drop one element on another with HTML5 drag-and-drop, such as a thumbnail onto
an empty viewer cell, use `dragTo`. It needs a source (`selector` or `targetRef`,
optionally filtered by `text`) and a drop target (`dropSelector` or `dropRef`,
optionally filtered by `dropText`) in the same frame. `point` and `dropPoint` are
CSS pixels inside each element and default to its visible center. `durationMs`
(100–5000, default 500) is how long the pointer takes to cross to the drop point.
`modifiers` are held throughout, for drops that copy with Ctrl.

```json
{ "action": "dragTo", "selector": "li[data-container]", "text": "Ball Phantom Axia",
  "dropSelector": "#D_3", "dropPoint": { "x": 200, "y": 150 }, "durationMs": 800 }
```

The runner presses the left button on the source and moves a few pixels toward the
drop target until Chromium starts the drag. Chromium's drag interception keeps the
drag inside the page, so no operating-system drag starts. The data the page set in
its own `dragstart` handler is passed unchanged to `dragenter`, `dragover` and
`drop`, and `dragend` fires on the source. Both ends are hit-tested before the
press, with the same covered, moved and replaced checks as `drag`. The drop target
is checked again just before the drop. A drop overlay that the page shows only
during the drag counts as covering the target unless it is inside the drop target.

The step fails, cancels the drag and releases the button when:

- no `dragstart` fires, or the page cancels it;
- no `dragover` handler calls `preventDefault()`, so the target never accepts the drop;
- the drop reaches an element outside the drop target;
- either end is missing, ambiguous, covered or moved.

The step's `data.dragAndDrop` reports `dragstartFired`, `dragstartOnSource`,
`dragoverAccepted`, `dropFired`, `dropAccepted` (the drop handler called
`preventDefault()`), `dropOnTarget`, `dragendFired`, `dropEffect` from `dragend`,
and a count of each drag event. The data itself is never reported. File drags and
custom or injected `DataTransfer` content are not supported. As with `drag`, assert
the app's state after the drop:

```json
{ "action": "assert", "selector": "#D_3", "condition": "text", "expected": "Ball Phantom Axia" }
```

Assertions check visibility, hidden state, visible element count, text containment,
exact field value, checkbox/radio state, URL containment, decoded images, or a
nonempty 2D canvas. Waits poll the same conditions. A plan must include an assertion
or a `compareScreenshot` step;
the assistant must cover each user expectation or explain what remains unverified.
Every step requires an `action`. `label` is optional and defaults to
`<action> step <n>` in reports; provide a short label when the step's purpose is
not obvious.
An image loading or a canvas painting does not establish correct visual content.
For WebGL and visual expectations, use the app's ready indicator, then compare
with a reference image, or have the assistant inspect a saved screenshot against
the expected result. A missing or unverifiable signal must not be reported as a pass.

For direct use, create a local UTF-8 plan:

```json
{
  "description": "Find and open an item",
  "expected": "The ITEM-42 details heading is displayed",
  "steps": [
    { "action": "fill", "label": "Search", "selector": "#search", "value": "ITEM-42" },
    { "action": "press", "label": "Submit search", "selector": "#search", "key": "Enter" },
    { "action": "waitFor", "label": "Wait for result", "selector": "[data-testid=search-result]", "text": "ITEM-42", "condition": "visible" },
    { "action": "doubleClick", "label": "Open result", "selector": "[data-testid=search-result]", "text": "ITEM-42" },
    { "action": "assert", "label": "Correct heading", "selector": "h1", "condition": "text", "expected": "ITEM-42 details" },
    { "action": "screenshot", "label": "Capture result" }
  ]
}
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:COPILOT_DESKTOP_BROWSER_HELPER" test-targets
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:COPILOT_DESKTOP_BROWSER_HELPER" test "C:\Temp\plan.json" -OutputPath "C:\Temp\new-report.json"
```

The optional CLI equivalents are `copilot-desktop browser test-targets [FRAME_ID]`
and `copilot-desktop browser test C:\Temp\plan.json C:\Temp\new-report.json`.
`test-targets [FRAME_ID]` returns bounded visible target metadata and CSS selector
suggestions without form values. Suggestions may need refinement for uniqueness.
Sensitive fill inputs may use `"valueFromEnv": "COPILOT_TEST_PASSWORD"` instead of
`value`; only explicit uppercase names starting with `COPILOT_TEST_` are accepted
by both the CLI and installed helper. Set these variables intentionally for your
test. Ordinary environment variables, such as service tokens, are rejected;
the assistant must not copy unrelated secrets into test variables or literals.
Reports identify the enabled origin. Credentials are
sent in the private POST body, never URL arguments. Input values are omitted from
the report and redacted if repeated in its labels. The HTTP service accepts no
file paths; the caller saves the report and PNGs. Outputs use new local absolute
paths and never overwrite existing files. If no output path is given, a unique
report filename is generated beside the plan. On a transport failure, inspect
**Last test** before rerunning actions; their result may already have taken effect.

Test screenshots mask form controls, credential-marked elements, recognizable
credential text, and embedded frames, but include canvas pixels for visual
evidence. Arbitrary application text/images can contain data; masking is not a
guarantee that every secret is detected. Frame screenshots are masked; read frame
snapshots and assert application readiness for embedded content.

A `screenshot` step can be cropped, for example to one viewport cell of a
multi-cell viewer. `region: {x, y, width, height}` takes CSS pixels in the
viewport (width and height 1–20000), or `selector`/`targetRef` (with optional
`text`) crops to one visible element of the top frame. The whole viewport is
captured and masked first and only then cut, so a mask never moves with the crop.
An element's bounds are read before and after the capture; if it moved or
resized, the step fails and no image is kept (add a `stable` wait first). A region
outside the visible viewport fails. The saved screenshot records the cropped
`region` in CSS pixels, and the step's `data.pixels` gives it in image pixels.

```json
{ "action": "screenshot", "label": "Axial cell", "selector": "#viewport-1" }
```

### Comparing with a reference image

`compareScreenshot` captures an element, a region or the whole viewport exactly as a
test screenshot does, and compares its pixels with a reference PNG. Use it to check
what an image viewer shows: window/level, colour lookup tables, orientation, zoom,
overlays and annotations.

```json
{ "action": "compareScreenshot", "label": "CT at W 400 L 40", "selector": "#viewport-1",
  "baseline": "C:\\tests\\viewer\\ct-w400-l40.png",
  "ignore": [{ "x": 0, "y": 0, "width": 220, "height": 60 }],
  "imageTolerance": { "channel": 8, "maxDiffRatio": 0.002 } }
```

- **`baseline`** is a local absolute `.png` path of at most 2 MiB. The helper's shell
  reads the file and sends it with the plan; the desktop never opens a path from the
  plan. On macOS and Linux the path must not contain a quote or backslash.
- **Making a reference:** run a `screenshot` step of the same area once, check the saved
  PNG, and use it as the baseline. Keep the same browser zoom and display scaling.
- **Size:** the capture must have the reference's exact pixel size. A different size
  fails the step with both sizes and the scale; nothing is rescaled.
- **`imageTolerance`:** `channel` (0–255, default 0) is how far one colour channel may
  move before a pixel counts as different, and `maxDiffRatio` (0–1, default 0) is the
  share of compared pixels that may differ. The defaults require an exact match;
  allow a little for anti-aliasing or GPU differences.
- **`ignore`:** 1–20 rectangles in CSS pixels relative to the compared area, for
  content that changes legitimately, such as dates, patient overlays or a frame
  counter. Ignored pixels are left out of the count.
- **Masks:** form controls, credential-marked elements and embedded frames are masked
  in both images, including any that sit under a canvas, so a change under a mask is
  not seen. Keep compared areas clear of them.
- **Result:** the step counts as an assertion, with outcome `assertion-passed` or
  `assertion-failed`, and is not retried. `data.comparison` reports the pixel size,
  CSS size and scale, the tolerance, the compared, ignored and differing pixels, the
  difference ratio, the largest channel difference, and `diffBounds` (the box around
  every differing pixel, in CSS pixels of the compared area; `diffBoundsPixels` in
  image pixels).
- **Evidence:** the capture is saved whether the step passes or fails (`kind:
  "capture"`). When any pixel differs, a diff image is saved too (`kind: "diff"`):
  the capture faded to grey, differing pixels in red and ignored areas dark. Each
  comparison reserves two image files; unused ones are removed.

A comparison checks pixels only. It cannot tell an intended change from a regression,
so a failed comparison needs a look at the capture and the diff image before the
reference is replaced.

Plans are limited to 128 KiB, not counting reference images, and 50 steps. Screenshots
and comparisons are limited to five together, and each image to 2 MiB.
The default run deadline is 120 seconds; `timeoutMs` can set up to 300 seconds.
Waits default to 30 seconds and assertions to 5 seconds; each can set `timeoutMs`
up to 60 seconds. Supported keys: Enter, Tab, Escape, Space, Backspace, Delete,
arrow keys, Home, End, PageUp and PageDown. `scroll` takes `pixels` between -2000
and 2000 and an optional container `selector`. `select` takes an option `value`.
`frame` and `text` are optional on target-based steps. `checked` expects a boolean;
`count` expects an integer; `text`, `value`, and `url` expect strings. A `url`
condition has no selector. Navigate uses `url`; screenshot optionally takes a
`region` or a target to crop to.

`frame` works with every condition, including `count`: the count is of visible
matches inside that one frame. Use the frame ID from `frames` or a discovery in
that frame. A count is never summed across frames, and another window is a
separate page:

```json
{ "action": "waitFor", "frame": "F3A1…", "selector": ".flyout-item", "condition": "count", "expected": 4 }
```

After building, `node scripts/browser-test-check.mjs` runs a real isolated Electron
workflow and verifies native input, expected results, screenshots, the installed
PowerShell helper, frames, cancellation, access control, and prevention of
subsequent writes after a failure. Evidence is saved in
`test-results/browser-testing/` and included in `npm run browser:check`.
To exercise fractional display scaling independently of the machine's display
setting, run `node scripts/browser-test-check.mjs --force-device-scale-factor=1.25`.
