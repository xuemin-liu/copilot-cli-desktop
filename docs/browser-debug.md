# Debug browser and Local Overrides

Select the **Open browser** button (window icon) in the terminal session's header, then enter a hostname
or HTTP/HTTPS URL. Bare public domains use HTTPS; loopback, private/link-local
addresses and development hosts (single-label names, `.localhost`, `.local`,
`.test`, `.internal`) use HTTP. Ports 443 and 8443 default to HTTPS, and explicit
HTTP/HTTPS always takes precedence. Each terminal session has its own browser page,
DevTools, console/network capture, and cookie/storage partition, separate from
other terminal sessions, the desktop shell, and your installed Chrome. Drag the divider
to resize it. Links with `target="_blank"`, JavaScript `window.open()` and forms
targeting a new page open browser page tabs inside the same terminal. They share
that terminal's login/storage and console/network capture. Select or close pages
using the page strip; navigation controls and DevTools apply to the selected page.
The address toolbar shows the selected page's actual browser zoom percentage.
Opening a child page preserves the source page, POST data and opener callbacks.
Only the primary page's saved URL is restored after app restart; child tabs are temporary.
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
while native DevTools is open but exclude request/response bodies and WebSocket
message frames. Inspect those in native Network.
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

Each session owns a read-only loopback API with a random bearer token saved in its
private Desktop session directory. It accepts no browser Origin requests and exposes
no navigation or file-write routes. It is independent of the background CLI
daemon; `copilot-desktop start` is not required. Desktop assigns the endpoint
path to its session's `COPILOT_DESKTOP_BROWSER_STATE` environment variable;
independent Desktop launches and their terminal tabs use different paths.

The same button, now labelled **Hide browser**, hides the pane and keeps its page, DevTools state, and capture
alive until the owning terminal session closes or the app quits. The **DevTools / Overrides** button toggles DevTools
visibility and keeps enabled overrides active while it is hidden. Browser pages have no desktop preload
bridge or Node integration. New pages accept HTTP/HTTPS and initial blank pages;
local files and other external protocols, downloads, and permission requests are blocked.

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
