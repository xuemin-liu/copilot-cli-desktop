import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { readBrowserControl, browserControlPath, type BrowserControlState } from './browser-control.js'

export async function terminalCommand(args: string[]): Promise<unknown> {
  const [action = 'list', id, cursor, ...extra] = args
  let body: unknown
  if (action === 'request' && id && cursor === undefined) {
    if (!isAbsolute(id) || (await stat(id)).size > 131072) throw new Error('Use an absolute request JSON path of at most 128 KiB')
    body = JSON.parse(await readFile(id, 'utf8'))
  } else if (action === 'list' && id === undefined) body = { action }
  else if (['read', 'interrupt', 'close'].includes(action) && id && !extra.length && (action === 'read' || cursor === undefined)) {
    if (cursor !== undefined && !/^\d+$/.test(cursor)) throw new Error('Invalid output cursor')
    body = { action, id, cursor: Number(cursor ?? 0) }
  } else throw new Error('Usage: terminal list|read <id> [cursor]|interrupt <id>|close <id>|request <absolute-request.json>')
  let control: BrowserControlState
  try { control = await readBrowserControl(process.env.COPILOT_DESKTOP_TERMINAL_STATE || browserControlPath()) }
  catch { throw new Error('Terminal control is unavailable. Open or resume a desktop session, or use the helper from a terminal in the active project.') }
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${control.port}/terminal`, { method: 'POST',
      headers: { authorization: `Bearer ${control.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(30000) })
  } catch { throw new Error('Terminal transport failed. Read the terminal before retrying input.') }
  const result = await response.json() as { message?: string }
  if (!response.ok) throw new Error(result.message ?? `Terminal request failed (${response.status})`)
  return result
}
