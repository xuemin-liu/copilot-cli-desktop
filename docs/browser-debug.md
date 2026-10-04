# Debug browser and Local Overrides

Select **Open browser** above the session workspace, then enter an HTTP or HTTPS
URL. The browser runs in Electron's Chromium engine and has a separate persistent
cookie session from the desktop shell and your installed Chrome. Drag the divider
to resize it. The last successful top-level page's origin and path are remembered;
query strings, fragments, and SPA route changes are not saved. Authentication
callback URLs do not replace the saved page. The pane starts hidden on app launch.

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

The pane also has **Console** and **Network** views. Network rows show method,
URL, HTTP status, timing, errors, redirects, and request/response headers. Select
a row for its details. These views retain the latest 300 entries in memory and
capture activity while native DevTools is open. They do not collect request or
response bodies or WebSocket message frames. Use native DevTools for those.
Credential headers (including cookies, API keys, authentication, token and session
headers), sensitive URL query parameters, and URL fragments are redacted from
activity and CLI output. Console filtering handles recognizable credential fields,
Bearer values and URLs, but arbitrary console text and URL paths may still contain
application data or secrets. Avoid logging secrets in the app you debug. The address
field and native DevTools display the real page URL so navigation and overrides work.

## Copilot CLI access

While the desktop app is running with the Browser pane opened at least once:

```text
copilot-desktop browser status
copilot-desktop browser console
copilot-desktop browser network
copilot-desktop browser request 123
```

All commands return JSON. `request` uses an ID from the network list. During
repository development, use `node dist/src/cli/cli.js browser console` and the
equivalent commands after building if the `copilot-desktop` executable is not
installed on PATH. Copilot's main session can run these commands through its shell
tool when that session's permissions allow it. Restricted side chats still expose
only their existing file-view/search tools.

The app owns a read-only loopback API with a random bearer token saved in the
private CLI state directory. It accepts no browser Origin requests and exposes
no navigation or file-write routes. It is independent of the background CLI
daemon; `copilot-desktop start` is not required. For an isolated desktop/test
instance, set `COPILOT_DESKTOP_BROWSER_STATE` to the same endpoint file path in
the desktop and CLI environments.

**Hide browser** hides the pane and keeps its page, DevTools state, and capture
alive until app quit. The **DevTools / Overrides** button toggles DevTools
visibility and keeps enabled overrides active while it is hidden. Browser pages have no desktop preload
bridge or Node integration. Pop-up windows, downloads, and permission requests
are blocked in this initial implementation.

Run `npm run browser:check` for the isolated real Electron test. It verifies
native local overrides and edited file refresh, CLI JSON output and access
control, console capture while DevTools is open, and pane visibility. Evidence
is saved in `test-results/browser-debug/`; no model calls are made.
