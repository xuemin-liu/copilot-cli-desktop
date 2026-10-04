import { copyFile, readFile, rename, rm, stat } from 'node:fs/promises'
import { writeFileAtomic } from './atomic-file.js'

type PreserveOperations = { rename: typeof rename; copyFile: typeof copyFile }

/**
 * Move an unreadable file aside, or, if the rename fails (for example a
 * transient share lock), copy it and confirm the copy. Returns the preserved
 * path only when an independent, verified backup exists; null means the
 * original must not be replaced.
 */
export async function preserveUnreadableFile(
  filename: string,
  operations: PreserveOperations = { rename, copyFile },
): Promise<string | null> {
  const preserved = `${filename}.corrupt-${Date.now()}`
  try {
    await operations.rename(filename, preserved)
    return preserved
  } catch { /* fall through to copy */ }
  try {
    await operations.copyFile(filename, preserved)
    const [original, copy] = await Promise.all([readFile(filename), readFile(preserved)])
    if (original.equals(copy)) return preserved
  } catch { /* no verified backup */ }
  await rm(preserved, { force: true }).catch(() => undefined)
  return null
}

/**
 * The recovery hold outlives the launch that detected the problem: while the
 * preserved file exists, data that only it references (browser profiles) must
 * not be pruned. Deleting or restoring the backup is the explicit
 * acknowledgement that releases the hold.
 */
export async function beginConfigRecovery(markerPath: string, preserved: string): Promise<void> {
  await writeFileAtomic(markerPath, `${JSON.stringify({ preserved, createdAt: new Date().toISOString() })}\n`)
}

/** The preserved file path while a recovery hold is active, otherwise null (clearing a stale marker). */
export async function activeConfigRecovery(markerPath: string): Promise<string | null> {
  let preserved: unknown
  try {
    preserved = (JSON.parse(await readFile(markerPath, 'utf8')) as { preserved?: unknown }).preserved
  } catch (error) {
    // An unreadable marker is treated as an active hold: keeping data is the safe side.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : markerPath
  }
  if (typeof preserved === 'string') {
    try { await stat(preserved); return preserved } catch { /* backup is gone: acknowledged */ }
  }
  await rm(markerPath, { force: true }).catch(() => undefined)
  return null
}

export interface ConfigRecoveryOutcome {
  /** Preserved-file path while browser data must be kept; null when pruning is safe. */
  hold: string | null
  /** True when an unreadable config could not be safely backed up: do not write desktop.json. */
  writesBlocked: boolean
  /** True when this launch just preserved an unreadable config. */
  newlyPreserved: boolean
}

/** Startup decision: protect the unreadable config and the data only it references, across restarts. */
export async function resolveConfigRecovery(
  configPath: string,
  markerPath: string,
  unparseable: boolean,
  operations?: PreserveOperations,
): Promise<ConfigRecoveryOutcome> {
  if (!unparseable) return { hold: await activeConfigRecovery(markerPath), writesBlocked: false, newlyPreserved: false }
  const preserved = await preserveUnreadableFile(configPath, operations)
  if (preserved && await beginConfigRecovery(markerPath, preserved).then(() => true, () => false)) {
    return { hold: preserved, writesBlocked: false, newlyPreserved: true }
  }
  return { hold: null, writesBlocked: true, newlyPreserved: false }
}
