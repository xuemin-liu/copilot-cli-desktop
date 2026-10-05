import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { getCliPaths, isProcessAlive } from './runtime-core.js'
import { BROWSER_READ_COMMANDS, browserReadMethod, validateBrowserReadCommand } from './browser-read-command.js'

export interface BrowserControlState { pid: number; port: number; token: string }

export function validateBrowserScreenshotPath(path: string): void {
  const windows = process.platform === 'win32'
  if (!isAbsolute(path) || !/\.png$/i.test(path) || /^[\\/]{2}/.test(path) || /[\u0000-\u001f]/.test(path)
    || (windows && (!/^[A-Za-z]:[\\/]/.test(path) || /[<>:"|?*]/.test(path.slice(2))
      || /(^|[\\/])(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|[\\/]|$)/i.test(path)))) {
    throw new Error('Screenshot output must be a local absolute .png path; network and device paths are not allowed.')
  }
}

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
  const readCommand = BROWSER_READ_COMMANDS.some(value => value === command)
  const readArgs = args.slice(1)
  const outputPath = command === 'screenshot' && (readArgs.length === 2
    || (readArgs.length === 1 && /\.png$/i.test(readArgs[0]!))) ? readArgs.pop() : undefined
  if (outputPath !== undefined) validateBrowserScreenshotPath(outputPath)
  if (readCommand) validateBrowserReadCommand(command, readArgs)
  else if (!['status', 'console', 'network', 'request'].includes(command)) {
    throw new Error('Use browser status, console, network, or request <id>.')
  }
  if (!readCommand && (extra.length || (command !== 'request' && argument !== undefined)
    || (command === 'request' && (!argument || !/^\d+$/.test(argument))))) {
    throw new Error('Usage: browser status|console|network|request <id>')
  }
  const state = await readBrowserControl()
  const query = new URLSearchParams()
  for (const arg of readArgs) query.append('arg', arg)
  const route = readCommand ? `/read/${command}?${query}` : command === 'request' ? `/request/${argument}` : `/${command}`
  let response: Response
  let body: unknown
  try {
    response = await fetch(`http://127.0.0.1:${state.port}${route}`, {
      method: readCommand ? browserReadMethod(command) : 'GET',
      headers: { authorization: `Bearer ${state.token}` },
      redirect: 'error', signal: AbortSignal.timeout(command === 'activate' ? 300000 : 30000),
    })
    body = await response.json()
  } catch {
    throw new Error('Browser control is not responding. Reopen the Browser pane.')
  }
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
      ? body.message : `Browser request failed (${response.status})`
    throw new Error(message)
  }
  if (outputPath && body && typeof body === 'object' && 'imageBase64' in body && typeof body.imageBase64 === 'string') {
    const { imageBase64, ...metadata } = body
    await writeFile(outputPath, Buffer.from(imageBase64, 'base64'), { flag: 'wx' })
    return { ...metadata, path: outputPath }
  }
  return body
}
