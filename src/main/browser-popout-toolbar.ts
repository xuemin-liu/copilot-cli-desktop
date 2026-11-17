import { createHash } from 'node:crypto'
import { WebContentsView } from 'electron'

export const BROWSER_POPOUT_TOOLBAR_HEIGHT = 40
const RETURN_URL = 'https://browser-popout.invalid/return'
const RELOAD_URL = 'https://browser-popout.invalid/reload'
// The only script: like the panel's reload button, Shift/Ctrl/Cmd+click asks for a hard reload.
const SCRIPT = `document.getElementById('reload').addEventListener('click',e=>{document.getElementById('hard').value=e.shiftKey||e.ctrlKey||e.metaKey?'1':'0'})`
const SCRIPT_HASH = createHash('sha256').update(SCRIPT).digest('base64')
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${SCRIPT_HASH}'; form-action ${RETURN_URL} ${RELOAD_URL}; base-uri 'none'">
<style>
html,body{margin:0;height:100%;background:#171b22;color:#c8d3e3;font:13px system-ui,sans-serif}
body{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 10px;box-sizing:border-box;border-bottom:1px solid #303846}
form{margin:0}button{font:inherit;color:inherit;background:#252c37;border:1px solid #465166;border-radius:5px;padding:5px 10px;cursor:pointer}
button:hover{background:#303b4b}button:focus-visible{outline:2px solid #58a6ff;outline-offset:2px}
#reload{width:28px;height:28px;padding:0;font-size:16px;line-height:1}
</style></head><body>
<form action="${RELOAD_URL}"><input type="hidden" id="hard" name="hard" value="0"><button type="submit" id="reload" title="Reload (Shift+click or Ctrl+Shift+R: hard reload that bypasses the cache)" aria-label="Reload page" aria-keyshortcuts="Control+Shift+R">↻</button></form>
<form action="${RETURN_URL}"><button type="submit" id="return">Return to panel</button></form>
<script>${SCRIPT}</script></body></html>`

/** App-owned chrome, isolated from the remote page and without a preload or IPC bridge. */
export function createBrowserPopoutToolbar(onReturn: () => void, onReload: (hard: boolean) => void, onError: (message: string) => void): WebContentsView {
  const view = new WebContentsView({ webPreferences: {
    partition: 'browser-popout-toolbar', sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false,
  } })
  view.setBackgroundColor('#171b22')
  const contents = view.webContents
  // A GET form with no fields may append an empty query string. No navigation is allowed.
  const command = (url: string): void => {
    if (url === RETURN_URL || url === `${RETURN_URL}?`) onReturn()
    else if (url === `${RELOAD_URL}?hard=0` || url === `${RELOAD_URL}?hard=1`) onReload(url.endsWith('=1'))
  }
  // Shift/Ctrl+click submits a form into a new window or tab, so the reload arrives here then.
  contents.setWindowOpenHandler(({ url }) => { command(url); return { action: 'deny' } })
  contents.on('will-navigate', (event, url) => { event.preventDefault(); command(url) })
  contents.on('will-redirect', event => event.preventDefault())
  void contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`).catch(error => {
    if (!contents.isDestroyed()) onError(`Could not load browser window controls: ${String(error)}`)
  })
  return view
}
