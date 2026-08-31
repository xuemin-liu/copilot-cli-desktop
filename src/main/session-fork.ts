import { cp, lstat, mkdtemp, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { forkStagedCopilotSession, isForkSessionId } from './copilot-rpc.js'
import { scanSessionHistory, SessionHistoryValidationError } from './session-history.js'
import type { CopilotResolution } from './types.js'

type ForkRequest = typeof forkStagedCopilotSession

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
  const staging = await mkdtemp(join(root, '.desktop-side-fork-'))
  try {
    const frozenHistory = join(staging, 'source-events.jsonl')
    let expected: Awaited<ReturnType<typeof scanSessionHistory>>
    try { expected = await scanSessionHistory(historyPath, sourceSessionId, frozenHistory) }
    catch (error) {
      const reason = error instanceof SessionHistoryValidationError
        ? 'The source history format is unsupported or invalid'
        : 'Could not read or snapshot the source history'
      throw new Error(`${reason}: ${error instanceof Error ? error.message : String(error)}. The original session was not changed.`, { cause: error })
    }
    const stagedSource = join(staging, 'session-state', sourceSessionId)
    await cp(source, stagedSource, {
      recursive: true,
      filter: async (path) => {
        // Only runtime files at the session root are excluded. Attachments
        // may legitimately have these names. Windows names ignore casing.
        const name = process.platform === 'win32' ? basename(path).toLowerCase() : basename(path)
        if (dirname(path) === source && /^(?:inuse\..*\.lock|\.workspace-fork\.lock|events\.jsonl)$/.test(name)) return false
        if ((await lstat(path)).isSymbolicLink()) throw new Error('Session contains symbolic links; it cannot be safely staged for forking')
        return true
      },
    })
    await rename(frozenHistory, join(stagedSource, 'events.jsonl'))
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
      const actual = await scanSessionHistory(join(stagedFork, 'events.jsonl'), forkId)
      if (expected.messages !== actual.messages || expected.digest !== actual.digest) throw new Error('Conversation was not preserved')
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
