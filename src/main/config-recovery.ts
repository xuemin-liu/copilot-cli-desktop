import { copyFile, readFile, rename, rm, stat } from 'node:fs/promises'
import { writeFileAtomic } from './atomic-file.js'

type PreserveOperations = { rename: typeof rename; copyFile: typeof copyFile }
type RecoveryOperations = Partial<PreserveOperations> & { stat?: typeof stat }

/**
 * Move an unreadable file aside, or, if the rename fails (for example a
 * transient share lock), copy it and confirm the copy. Returns the preserved
 * path only when an independent, verified backup exists; null means the
 * original must not be replaced.
 */
export async function preserveUnreadableFile(
  filename: string,
  operations: PreserveOperations = { rename, copyFile },
  preserved = `${filename}.corrupt-${Date.now()}`,
): Promise<string | null> {
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
export async function activeConfigRecovery(markerPath: string, statPath: typeof stat = stat): Promise<string | null> {
  let preserved: unknown
  try {
    preserved = (JSON.parse(await readFile(markerPath, 'utf8')) as { preserved?: unknown }).preserved
  } catch (error) {
    // An unreadable marker is treated as an active hold: keeping data is the safe side.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : markerPath
  }
  if (typeof preserved === 'string') {
    try {
      await statPath(preserved)
      return preserved
    } catch (error) {
      // Only a confirmed missing backup means it was restored or deleted. EACCES/EPERM/I/O errors prove nothing.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return preserved
    }
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

async function isConfigUnparseableOnDisk(configPath: string): Promise<boolean> {
  try {
    JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''))
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    if (error instanceof SyntaxError) return true
    return true
  }
}

async function readExistingHoldPath(markerPath: string, statPath: typeof stat = stat): Promise<string | null> {
  let preserved: unknown
  try {
    preserved = (JSON.parse(await readFile(markerPath, 'utf8')) as { preserved?: unknown }).preserved
  } catch {
    return null
  }
  if (typeof preserved !== 'string') return null
  try {
    await statPath(preserved)
    return preserved
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : preserved
  }
}

async function nextCorruptBackupPath(configPath: string, statPath: typeof stat = stat): Promise<string> {
  const base = `${configPath}.corrupt-${Date.now()}`
  let candidate = base
  for (let suffix = 1; ; suffix++) {
    const exists = await statPath(candidate).then(() => true, (error) => (error as NodeJS.ErrnoException).code !== 'ENOENT')
    if (!exists) return candidate
    candidate = `${base}-${suffix}`
  }
}

/** Startup decision: protect the unreadable config and the data only it references, across restarts. */
export async function resolveConfigRecovery(
  configPath: string,
  markerPath: string,
  unparseable: boolean,
  operations: RecoveryOperations = {},
): Promise<ConfigRecoveryOutcome> {
  if (unparseable) {
    unparseable = await isConfigUnparseableOnDisk(configPath)
  }
  if (!unparseable) {
    return { hold: await activeConfigRecovery(markerPath, operations.stat), writesBlocked: false, newlyPreserved: false }
  }
  const previousHold = await readExistingHoldPath(markerPath, operations.stat)
  // Publish the hold BEFORE touching the original. If the marker cannot be written the original stays
  // in place untouched; if we are interrupted after the move, the marker already names the backup.
  const target = await nextCorruptBackupPath(configPath, operations.stat)
  const held = await beginConfigRecovery(markerPath, target).then(() => true, () => false)
  if (held) {
    const preserved = await preserveUnreadableFile(
      configPath,
      { rename: operations.rename ?? rename, copyFile: operations.copyFile ?? copyFile },
      target,
    )
    if (preserved) return { hold: preserved, writesBlocked: false, newlyPreserved: true }
    // Nothing was preserved: the original is intact, so restore any prior backup hold or remove the new marker.
    if (previousHold) {
      await beginConfigRecovery(markerPath, previousHold).catch(() => undefined)
      return { hold: previousHold, writesBlocked: true, newlyPreserved: false }
    }
    await rm(markerPath, { force: true }).catch(() => undefined)
  }
  return { hold: previousHold, writesBlocked: true, newlyPreserved: false }
}
