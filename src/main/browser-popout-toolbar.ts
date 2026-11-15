import { WebContentsView } from 'electron'

export const BROWSER_POPOUT_TOOLBAR_HEIGHT = 40
const RETURN_URL = 'https://browser-popout.invalid/return'
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action https://browser-popout.invalid/return; base-uri 'none'">
<style>
html,body{margin:0;height:100%;background:#171b22;color:#c8d3e3;font:13px system-ui,sans-serif}
body{display:flex;align-items:center;justify-content:flex-end;padding:0 10px;box-sizing:border-box;border-bottom:1px solid #303846}
form{margin:0}button{font:inherit;color:inherit;background:#252c37;border:1px solid #465166;border-radius:5px;padding:5px 10px;cursor:pointer}
button:hover{background:#303b4b}button:focus-visible{outline:2px solid #58a6ff;outline-offset:2px}
</style></head><body><form action="${RETURN_URL}"><button type="submit">Return to panel</button></form></body></html>`

/** App-owned chrome, isolated from the remote page and without a preload or IPC bridge. */
export function createBrowserPopoutToolbar(onReturn: () => void, onError: (message: string) => void): WebContentsView {
  const view = new WebContentsView({ webPreferences: {
    partition: 'browser-popout-toolbar', sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false,
  } })
  view.setBackgroundColor('#171b22')
  const contents = view.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => {
    event.preventDefault()
    // A GET form with no fields may append an empty query string. No navigation is allowed.
    if (url === RETURN_URL || url === `${RETURN_URL}?`) onReturn()
  })
  contents.on('will-redirect', event => event.preventDefault())
  void contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`).catch(error => {
    if (!contents.isDestroyed()) onError(`Could not load browser window controls: ${String(error)}`)
  })
  return view
}
