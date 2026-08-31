import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { forkStagedCopilotSession, isForkSessionId } from './copilot-rpc.js'
import type { CopilotResolution } from './types.js'

type ForkRequest = typeof forkStagedCopilotSession
const MAX_HISTORY_BYTES = 128 * 1024 * 1024
type HistoryEvent = { type?: string; data?: { sessionId?: string; content?: unknown } }

function conversationKey(event: HistoryEvent): string | null {
  return event.type === 'user.message' || event.type === 'assistant.message'
    ? JSON.stringify([event.type, event.data?.content]) : null
}

export function copilotSessionRoot(env: NodeJS.ProcessEnv): string {
  return join(resolve(env.COPILOT_HOME || join(homedir(), '.copilot')), 'session-state')
}

/** Do not mutate, resume, lock, or rename the live source. Fork only inside
 * a disposable COPILOT_HOME on the same volume, then atomically publish the
 * fresh child directory. Copilot owns the fork's event/metadata format.
 */
export async function forkSessionSnapshot(
  resolution: CopilotResolution,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  sourceSessionId: string,
  title: string,
  requestFork: ForkRequest = forkStagedCopilotSession,
): Promise<string> {
  if (!isForkSessionId(sourceSessionId)) throw new Error('Enter the full source session UUID shown by /session in Copilot')
  const root = copilotSessionRoot(environment)
  const source = join(root, sourceSessionId)
  const historyPath = join(source, 'events.jsonl')
  const sourceInfo = await lstat(source).catch(() => null)
  if (!sourceInfo?.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('The source must be an existing local Copilot session')
  const historyInfo = await lstat(historyPath).catch(() => null)
  if (!historyInfo?.isFile() || historyInfo.size > MAX_HISTORY_BYTES) throw new Error('The source has no saved history, or its history is too large to fork safely')
  const history = await readFile(historyPath, 'utf8')
  // A concurrently streaming final event may not be complete yet. Only
  // publish whole persisted records; the dialog explains this boundary.
  const completeHistory = history.slice(0, history.lastIndexOf('\n') + 1)
  if (!completeHistory) throw new Error('Wait for Copilot to save conversation history before forking')
  const events = completeHistory.trim().split('\n').map((line) => JSON.parse(line) as HistoryEvent)
  if (!events.some((event) => event.type === 'session.start' && event.data?.sessionId === sourceSessionId)) {
    throw new Error('This Copilot session history format is not supported for safe forking')
  }
  const staging = await mkdtemp(join(root, '.desktop-side-fork-'))
  try {
    const stagedSource = join(staging, 'session-state', sourceSessionId)
    await cp(source, stagedSource, {
      recursive: true,
      filter: async (path) => {
        if (/^(?:inuse\..*\.lock|\.workspace-fork\.lock|events\.jsonl)$/.test(basename(path))) return false
        if ((await lstat(path)).isSymbolicLink()) throw new Error('Session contains symbolic links; it cannot be safely staged for forking')
        return true
      },
    })
    await mkdir(stagedSource, { recursive: true })
    await writeFile(join(stagedSource, 'events.jsonl'), completeHistory, { flag: 'wx' })
    const forkId = await requestFork(resolution, cwd, {
      ...environment, COPILOT_HOME: staging, COPILOT_DISABLE_KEYTAR: '1',
    }, sourceSessionId, title)
    if (!isForkSessionId(forkId) || forkId === sourceSessionId) throw new Error('Copilot did not create an independent fork')
    const stagedFork = join(staging, 'session-state', forkId)
    const forkInfo = await lstat(stagedFork)
    if (!forkInfo.isDirectory() || forkInfo.isSymbolicLink()) throw new Error('Invalid fork directory returned by Copilot')
    // Refuse to overwrite any existing session. UUIDs come from Copilot,
    // but existence checks are still required before publishing a folder.
    const destination = join(root, forkId)
    if (await lstat(destination).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })) throw new Error('Copilot returned a session ID that already exists; no history was replaced')
    // Reject empty or incompatible helper output instead of opening a
    // context-less side chat. Copilot may rewrite event IDs/metadata, but
    // the saved conversation must survive in its original order.
    try {
      const forkHistoryPath = join(stagedFork, 'events.jsonl')
      const forkHistoryInfo = await lstat(forkHistoryPath)
      if (!forkHistoryInfo.isFile() || forkHistoryInfo.size > MAX_HISTORY_BYTES) throw new Error('Invalid history file')
      const forkEvents = (await readFile(forkHistoryPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as HistoryEvent)
      if (!forkEvents.some((event) => event.type === 'session.start' && event.data?.sessionId === forkId)) throw new Error('Missing fork start')
      const expected = events.map(conversationKey).filter((key) => key !== null)
      const actual = forkEvents.map(conversationKey).filter((key) => key !== null)
      if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Conversation was not preserved')
    } catch {
      throw new Error('Copilot returned incomplete or unsupported fork history; the original session was not changed')
    }
    await rename(stagedFork, destination)
    return forkId
  } finally {
    // `staging` is the unique mkdtemp child above, never the live source/root.
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}
