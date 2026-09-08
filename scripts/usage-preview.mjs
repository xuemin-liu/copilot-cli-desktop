// Local UI fixture. No connection to the user's usage database.
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const report = {
  month: '2026-09', timezone: 'America/Chicago', months: ['2026-09', '2026-08'],
  totals: { input: 29567, output: 1717, cacheRead: 145915, cacheWrite: 40272, reasoning: 570 },
  unallocated: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  models: [{ name: 'Example model', input: 29567, output: 1717, cacheRead: 145915, cacheWrite: 40272, reasoning: 570, requests: 7, source: 'requests' }],
  sessions: [{ name: '12345678-1234-1234-1234-123456789012', input: 29567, output: 1717, cacheRead: 145915, cacheWrite: 40272, reasoning: 570, requests: 7, source: 'requests' }],
  warnings: ['Recorded usage may be incomplete where Copilot history was lost before collection. App scope includes whole sessions observed in the app, including usage outside the app.'],
  lastCollected: '2026-09-08T15:30:00Z', lastBackup: '2026-09-08T15:30:00Z', databasePath: 'C:\\Users\\Example\\AppData\\Roaming\\Copilot CLI Desktop\\usage.sqlite',
}
const bundle = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {UsageSettings} from './src/renderer/components/UsageSettings.tsx';
    let report=${JSON.stringify(report)};
    window.copilotDesktopSettings={usageReport:async(month,scope,timezone)=>{if(timezone){new Intl.DateTimeFormat('en',{timeZone:timezone});report.timezone=timezone;}return {...report,month};},refreshUsage:async()=>{},exportUsage:async()=>true,restoreUsage:async()=>true};
    createRoot(document.getElementById('root')).render(<div className="settings-app"><UsageSettings/></div>);`, loader: 'tsx', resolveDir: process.cwd() },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
})
const css = await readFile(resolve('src/renderer/styles.css'))
createServer((request, response) => {
  if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents) }
  else if (request.url === '/styles.css') { response.setHeader('Content-Type', 'text/css'); response.end(css) }
  else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><title>Monthly usage preview</title><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>') }
}).listen(4179, '127.0.0.1', () => console.log('Usage preview: http://127.0.0.1:4179'))
