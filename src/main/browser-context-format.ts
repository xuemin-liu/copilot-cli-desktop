import type { BrowserConsoleEntry, BrowserNetworkEntry } from './browser-debug-types.js'

const MAX_CONSOLE_LINES = 25
const MAX_REQUEST_LINES = 10
const MAX_CONTEXT_TEXT = 4000

function line(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]+/g, ' ').trim().slice(0, max)
}

/** Prompt text for what went wrong on the selected page: console errors and warnings (or the latest messages when
 * there are none) and failed requests. Entries are already filtered when they are captured; this only selects and bounds them. */
export function formatBrowserContext(page: { url: string; pageId: number; console: BrowserConsoleEntry[]; network: BrowserNetworkEntry[] }): string | null {
  const messages = page.console.filter(entry => entry.pageId === page.pageId)
  const problems = messages.filter(entry => entry.level === 'error' || entry.level === 'warning')
  const shown = (problems.length ? problems : messages).slice(-(problems.length ? MAX_CONSOLE_LINES : 10))
  const failed = page.network.filter(entry => entry.pageId === page.pageId && (entry.error || (entry.status !== null && entry.status >= 400))).slice(-MAX_REQUEST_LINES)
  if (!shown.length && !failed.length) return null
  const lines = [`[Browser console] ${line(page.url, 300) || 'selected page'}`]
  if (shown.length) {
    lines.push(problems.length ? `Console errors and warnings (${problems.length > shown.length ? `latest ${shown.length} of ${problems.length}` : shown.length}):` : `No errors or warnings; latest console messages:`)
    for (const entry of shown) lines.push(`- ${entry.level}: ${line(entry.message, 400)}${entry.source ? ` (${line(entry.source, 160)}${entry.line ? `:${entry.line}` : ''})` : ''}`)
  }
  if (failed.length) {
    lines.push(`Failed requests (${failed.length}):`)
    for (const entry of failed) lines.push(`- ${entry.method} ${line(entry.url, 300)} → ${entry.error ?? entry.status}`)
  }
  return lines.join('\n').slice(0, MAX_CONTEXT_TEXT)
}
