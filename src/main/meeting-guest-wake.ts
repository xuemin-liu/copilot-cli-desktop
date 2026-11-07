import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { win32 } from 'node:path'
import { windowsSystemExecutable } from './resolve-copilot.js'
import type { GuestSeat, GuestWatchEnd } from './meeting-guests.js'

/**
 * Reaching an outside agent after its turn ended (docs/meeting-tools-setup.md). What each agent offers was measured, and MCP
 * notifications wake neither. Codex takes a message for an existing thread from `codex queue`, which starts a turn in the app or
 * terminal that has the thread open, and waits for the running turn if there is one. Claude Code wakes when a background command
 * of its own exits, so it keeps one running that the desktop answers. The text is always the desktop's own words: nothing a
 * model wrote goes through here.
 */

export const CODEX_THREAD_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const GUEST_WAKE_PATH = /^\/meeting-wake\/([0-9a-f]{32})$/
const CODEX_QUEUE_TIMEOUT_MS = 30_000

/** The client names in MCP `initialize`. */
export const isClaudeCodeClient = (client: string | null): boolean => client === 'claude-code'
export const isCodexClient = (client: string | null): boolean => client === 'codex-mcp-client'

/** What a woken agent reads. A host holding replies has to answer them: another meeting_next would count as not answering. */
export function guestWakeText(seat: GuestSeat, holding: boolean): string {
  const meeting = `[Copilot CLI Desktop] Meeting ${seat.meetingId}`
  if (seat.closed !== null) return `${meeting} is closed and has a last message for you. Call meeting_next once to read it.`
  if (seat.kind === 'host' && holding) return `${meeting} is waiting for your answer to the reviewers' replies. Answer with meeting_round, meeting_propose_close or meeting_end, then call meeting_next.`
  return `${meeting} has a message for you. Call meeting_next and answer what it gives you, unless the person told you to stop.`
}

/** What the background command prints when it ends. */
export function guestWatchText(seat: GuestSeat, end: GuestWatchEnd): string {
  switch (end) {
    case 'wake': return guestWakeText(seat, false)
    case 'closed': return seat.farewell === null ? `Meeting ${seat.meetingId} is over; there is nothing more to do for it.` : guestWakeText(seat, false)
    case 'replaced': return `A newer wake-up for meeting ${seat.meetingId} took over from this one.`
  }
}

/** Waits without a time limit. It retries while the desktop is away, so a restart does not wake the agent for nothing. */
export function guestWakeCommand(url: string, windows = process.platform === 'win32'): string {
  return `${windows ? 'curl.exe' : 'curl'} -sS --retry 720 --retry-delay 5 --retry-all-errors -X POST ${url}`
}

/** What the meeting tools ask of Claude Code, whose turn can otherwise end for good. */
export function guestWakeRequest(command: string): string {
  return `Keep a wake-up running, once: start this with the Bash tool in the background (run_in_background: true), and do not wait for it: ${command} . It uses no tokens, and exits only if you have a message and are not calling meeting_next; its exit wakes you even after your turn ended. When it exits, call meeting_next. If you cannot start it, go on without it.`
}

export interface CodexQueueDeps {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  run(file: string, args: readonly string[], options?: { windowsVerbatimArguments?: boolean }): Promise<string>
}

const realDeps: CodexQueueDeps = {
  env: process.env,
  platform: process.platform,
  run: (file, args, options) => new Promise((resolve, reject) => {
    execFile(file, [...args], { cwd: homedir(), timeout: CODEX_QUEUE_TIMEOUT_MS, windowsHide: true, ...options }, (error, stdout) => { if (error) reject(error); else resolve(stdout) })
  }),
}

/** `codex` on the PATH first, then on Windows the one inside the Codex app, which puts nothing on the PATH. */
async function codexPaths(deps: CodexQueueDeps): Promise<string[]> {
  if (deps.platform !== 'win32') return ['codex']
  const lines = (text: string): string[] => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const onPath = await deps.run(windowsSystemExecutable('where.exe', deps.env), ['codex']).catch(() => '')
  const app = await deps.run(windowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe', deps.env), ['-NoProfile', '-NonInteractive', '-Command', '(Get-AppxPackage OpenAI.Codex).InstallLocation']).catch(() => '')
  return [...lines(onPath).filter((path) => /\.(exe|cmd)$/i.test(path)), ...lines(app).map((location) => win32.join(location, 'app', 'resources', 'codex.exe'))]
}

/** All the desktop's wake texts pass; anything cmd.exe could read as more than text does not reach an npm shim. */
const SHIM_SAFE = /^[A-Za-z0-9 .,:;'[\]_-]+$/

/**
 * Queues `text` for a Codex thread; true when a Codex took it. A Codex too old for `queue` fails, and the next one is tried. A
 * thread that nothing has open keeps the message until it is opened. No shell is involved, except for an npm install on Windows,
 * which is a `.cmd` only cmd.exe starts; that gets only the checked thread id and text.
 */
export async function queueCodexWake(threadId: string, text: string, deps: CodexQueueDeps = realDeps): Promise<boolean> {
  if (!CODEX_THREAD_PATTERN.test(threadId)) return false
  for (const path of await codexPaths(deps)) {
    try {
      if (/\.cmd$/i.test(path)) {
        if (/["%]/.test(path) || !SHIM_SAFE.test(text)) continue
        const line = `""${path}" queue --thread ${threadId} --message "${text}""`
        await deps.run(windowsSystemExecutable('cmd.exe', deps.env), ['/d', '/s', '/c', line], { windowsVerbatimArguments: true })
      } else {
        await deps.run(path, ['queue', '--thread', threadId, '--message', text])
      }
      return true
    } catch { /* Too old for `queue`, or gone: try the next one. */ }
  }
  return false
}
