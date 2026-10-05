# Debug browser and Local Overrides

Select the **Open browser** button (window icon) in the terminal session's header, then enter a hostname
or HTTP/HTTPS URL. Bare public domains use HTTPS; loopback, private/link-local
addresses and development hosts (single-label names, `.localhost`, `.local`,
`.test`, `.internal`) use HTTP. Ports 443 and 8443 default to HTTPS, and explicit
HTTP/HTTPS always takes precedence. Each terminal session has its own browser pages,
DevTools, console/network capture, and cookie/storage partition, separate from
other terminal sessions, the desktop shell, and your installed Chrome. Drag the divider
to resize it. Use **+ (New page)** in the page strip to open another page in the
same session, then enter its address. New pages share the session's login and
storage, keep other pages open, and are selected automatically. Up to 32 pages
can be open in one session. Links with `target="_blank"`, JavaScript `window.open()` and forms
targeting a new page open browser page tabs inside the same terminal. They share
that terminal's login/storage and console/network capture. Select or close pages
using the page strip; navigation controls and DevTools apply to the selected page.
The address toolbar shows the selected page's actual browser zoom percentage.
Opening a child page preserves the source page, POST data and opener callbacks.
Only the primary page's saved URL is restored after app restart; additional pages are temporary.
Restored terminal sessions retain their browser cookies, local storage,
and last successful top-level page's origin and path across app restarts;
query strings, fragments, and SPA route changes are not saved. Authentication
callback URLs do not replace the saved page. The pane starts hidden in a new
session. Switching terminal tabs preserves each session's browser. Pop-out and
docking move the same browser page with its terminal.
Explicitly closing a terminal session clears its browser credentials, storage and
cache and removes its saved page and diagnostic helper files. App quit preserves
restorable profiles. Startup removes orphaned profiles/partitions and old helper
directories; Chromium's open partition files are removed after the previous
process exits.

Select **DevTools / Overrides**, then **Sources → Overrides** in the embedded
DevTools. Select the folder you already use for Chrome Local Overrides and enable
Local Overrides. Chrome's saved override files are ordinary local files and can
be reused. The folder selection must be configured once in this app; Chrome's
profile settings are not imported automatically. DevTools remembers the selection.

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

## Copilot CLI access

Local Copilot processes launched by Desktop receive browser diagnostic
instructions and a session-specific helper automatically. Ask **"Find any
exceptions in the browser console"** or **"Inspect failed network requests"** in
the terminal. Copilot can run the read-only helper through its existing shell tool;
no third-party MCP, Node installation, or desktop CLI installation is required.
Open that terminal session's Browser pane and load the web app first.

To read the same data directly from a shell inheriting that session's environment:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:COPILOT_DESKTOP_BROWSER_HELPER" console
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:COPILOT_DESKTOP_BROWSER_HELPER" network
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
private Desktop session directory. It accepts no browser Origin requests and exposes
no arbitrary JavaScript, CDP, storage, credential or file-write routes. Test plans
can navigate to HTTP/HTTPS pages only while Testing mode is enabled.
Constrained browser reading actions use the same authenticated transport. It is independent of the background CLI
daemon; `copilot-desktop start` is not required. Desktop assigns the endpoint
path to its session's `COPILOT_DESKTOP_BROWSER_STATE` environment variable;
independent Desktop launches and their terminal tabs use different paths.

The same button, now labelled **Hide browser**, hides the pane and keeps its page, DevTools state, and capture
alive until the owning terminal session closes or the app quits. The **DevTools / Overrides** button toggles DevTools
visibility and keeps enabled overrides active while it is hidden. Browser pages have no desktop preload
bridge or Node integration. New pages accept HTTP/HTTPS and initial blank pages;
local files and other external protocols, downloads, and permission requests are blocked.

## Reading authenticated Jira tickets and other pages

Ask the session's Copilot **"Read this Jira ticket, including its comments and linked
issues"** after loading it in that session's Browser pane and signing in normally.
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
and sensitive URLs, and withholds HTML, scripts, plain text, binaries, invalid JSON
and oversized bodies. Partial JSON is
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

1. Open the web app in the session browser and select the page to test.
2. Enable **Testing mode** below the browser views.
3. Tell the session assistant the steps, inputs, and expected results. For example:
   “Search for ITEM-42, open its details with a double-click, and verify that the
   title is ITEM-42 details, the preview has loaded, and no error banner appears.”
4. The assistant inspects the page, creates and runs a test plan, checks your
   expectations, and reports passed, failed, and skipped checks with evidence.

This works with general web apps. There is no viewer-specific workflow. Existing
login and storage are reused. The assistant receives test instructions when a
local CLI session starts; start a new CLI session after updating Desktop to load
the new guidance. You provide the test description; the assistant prepares the
structured plan. A user does not need to write selectors or JSON manually.

Testing mode authorizes the described test's interactions without a confirmation
per step. **Stop testing** cancels the run and disables further tests. Selecting,
creating, or closing the active page also cancels and resets Testing mode; re-enable
it on the new page to test there. Hiding the pane or selecting another browser
view also stops the run and resets Testing mode. Navigating within the selected page preserves
Testing mode. Popup activation changes the selected page and stops the old run.
A run stops at its first failed step. Test actions may change the app's data; a
failed or cancelled run does not undo completed steps. Keep the Page view visible
for input and screenshots. Browser sessions remain isolated from each other.

The runner supports navigation, click, double-click, hover, text entry and replacement,
single-choice select elements, keyboard keys, document/container scrolling, waits,
assertions, and screenshots. CSS selectors plus optional visible text identify
targets. Exactly one visible enabled target is required for input. Covered targets
are rejected. Pointer actions recheck the target after hover-driven layout changes
and stop if the element is replaced or does not stabilize. Open shadow roots and same/cross-origin frames are supported; use
current frame IDs from `frames`. Closed shadow roots, rotated/skewed frames,
uploads, downloads, drag-and-drop, and arbitrary JavaScript are unavailable.

Assertions check visibility, hidden state, visible element count, text containment,
exact field value, checkbox/radio state, URL containment, decoded images, or a
nonempty 2D canvas. Waits poll the same conditions. A plan must include an assertion;
the assistant must cover each user expectation or explain what remains unverified.
An image loading or a canvas painting does not establish correct visual content.
For WebGL and visual expectations, use the app's ready indicator and have the
assistant inspect a saved screenshot against the expected result. A missing or
unverifiable signal must not be reported as a pass.

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
Sensitive fill inputs may use `"valueFromEnv": "USER_SUPPLIED_ENV_NAME"` instead of
`value`; only that explicit variable is resolved by the caller. Credentials are
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

Plans are limited to 128 KiB, 50 steps, and five screenshots of up to 2 MiB each.
The default run deadline is 120 seconds; `timeoutMs` can set up to 300 seconds.
Waits default to 30 seconds and assertions to 5 seconds; each can set `timeoutMs`
up to 60 seconds. Supported keys: Enter, Tab, Escape, Space, Backspace, Delete,
arrow keys, Home, End, PageUp and PageDown. `scroll` takes `pixels` between -2000
and 2000 and an optional container `selector`. `select` takes an option `value`.
`frame` and `text` are optional on target-based steps. `checked` expects a boolean;
`count` expects an integer; `text`, `value`, and `url` expect strings. A `url`
condition has no selector. Navigate uses `url`; screenshot takes no target.

After building, `node scripts/browser-test-check.mjs` runs a real isolated Electron
workflow and verifies native input, expected results, screenshots, the installed
PowerShell helper, frames, cancellation, access control, and prevention of
subsequent writes after a failure. Evidence is saved in
`test-results/browser-testing/` and included in `npm run browser:check`.
