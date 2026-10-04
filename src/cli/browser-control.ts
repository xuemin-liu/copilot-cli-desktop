import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getCliPaths, isProcessAlive } from './runtime-core.js'

export interface BrowserControlState { pid: number; port: number; token: string }

export function browserControlPath(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.COPILOT_DESKTOP_BROWSER_STATE ?? join(getCliPaths(environment).root, 'browser.json')
}

export async function readBrowserControl(path = browserControlPath()): Promise<BrowserControlState> {
  let state: Partial<BrowserControlState>
  try { state = JSON.parse(await readFile(path, 'utf8')) as Partial<BrowserControlState> }
  catch { throw new Error('Open the Browser pane in Copilot CLI Desktop first.') }
  if (!state || !Number.isInteger(state.pid) || state.pid! < 1 || !isProcessAlive(state.pid!)
    || !Number.isInteger(state.port) || state.port! < 1 || state.port! > 65535
    || typeof state.token !== 'string' || !/^[a-f0-9]{64}$/.test(state.token)) {
    throw new Error('Browser control state is stale or invalid. Reopen the Browser pane.')
  }
  return state as BrowserControlState
}

export async function browserCommand(args: string[]): Promise<unknown> {
  const [command = 'status', argument, ...extra] = args
  if (!['status', 'console', 'network', 'request'].includes(command)) {
    throw new Error('Use browser status, console, network, or request <id>.')
  }
  if (extra.length || (command !== 'request' && argument !== undefined)
    || (command === 'request' && (!argument || !/^\d+$/.test(argument)))) {
    throw new Error('Usage: browser status|console|network|request <id>')
  }
  const state = await readBrowserControl()
  const route = command === 'request' ? `/request/${argument}` : `/${command}`
  const response = await fetch(`http://127.0.0.1:${state.port}${route}`, {
    headers: { authorization: `Bearer ${state.token}` },
    redirect: 'error', signal: AbortSignal.timeout(5000),
  })
  const body = await response.json() as { message?: string }
  if (!response.ok) throw new Error(body.message ?? `Browser request failed (${response.status})`)
  return body
}
