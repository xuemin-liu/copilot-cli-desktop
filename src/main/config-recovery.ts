import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { copyFile, readFile, rename, rm, stat } from 'node:fs/promises'
import { writeFileAtomic } from './atomic-file.js'

type PreserveOperations = { rename: typeof rename; copyFile: typeof copyFile }
export type RecoveryOperations = Partial<PreserveOperations> & { stat?: typeof stat }

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

type ConfigFileProbe =
  | { state: 'parseable' }
  | { state: 'missing' }
  | { state: 'unparseable'; raw: Buffer }
  | { state: 'io-error' }

function isParseableConfigBuffer(raw: Buffer): boolean {
  try {
    JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''))
    return true
  } catch {
    return false
  }
}

async function probeConfigFile(configPath: string): Promise<ConfigFileProbe> {
  try {
    const raw = await readFile(configPath)
    return isParseableConfigBuffer(raw) ? { state: 'parseable' } : { state: 'unparseable', raw }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'missing' }
      : { state: 'io-error' }
  }
}

async function restorePreservedValidConfig(preserved: string, configPath: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await copyFile(preserved, configPath, fsConstants.COPYFILE_EXCL)
      await rm(preserved, { force: true }).catch(() => undefined)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return false
      }
    }
    const currentOnDisk = await probeConfigFile(configPath)
    if (currentOnDisk.state === 'parseable') {
      await rm(preserved, { force: true }).catch(() => undefined)
      return true
    }
    if (currentOnDisk.state !== 'missing') {
      return false
    }
  }
  return false
}

interface ExistingHoldSnapshot {
  hold: string | null
  rawMarker: string | null
  markerUnreadable: boolean
}

async function snapshotExistingHold(markerPath: string, statPath: typeof stat = stat): Promise<ExistingHoldSnapshot> {
  let rawMarker: string
  try {
    rawMarker = await readFile(markerPath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EISDIR') {
      return { hold: null, rawMarker: null, markerUnreadable: false }
    }
    return { hold: markerPath, rawMarker: null, markerUnreadable: true }
  }
  let preserved: unknown
  try {
    preserved = (JSON.parse(rawMarker) as { preserved?: unknown }).preserved
  } catch {
    return { hold: markerPath, rawMarker, markerUnreadable: false }
  }
  if (typeof preserved !== 'string') {
    return { hold: null, rawMarker: null, markerUnreadable: false }
  }
  try {
    await statPath(preserved)
    return { hold: preserved, rawMarker, markerUnreadable: false }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { hold: null, rawMarker: null, markerUnreadable: false }
      : { hold: preserved, rawMarker, markerUnreadable: false }
  }
}

async function nextCorruptBackupPath(configPath: string, statPath: typeof stat = stat): Promise<string | null> {
  const base = `${configPath}.corrupt-${Date.now()}`
  for (let suffix = 0; suffix < 16; suffix++) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`
    try {
      await statPath(candidate)
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? candidate : null
    }
  }
  const fallback = `${base}-${randomUUID()}`
  try {
    await statPath(fallback)
    return null
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? fallback : null
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
    const initialProbe = await probeConfigFile(configPath)
    if (initialProbe.state === 'parseable' || initialProbe.state === 'missing') {
      unparseable = false
    }
  }
  if (!unparseable) {
    return { hold: await activeConfigRecovery(markerPath, operations.stat), writesBlocked: false, newlyPreserved: false }
  }
  const existing = await snapshotExistingHold(markerPath, operations.stat)
  if (existing.markerUnreadable) {
    return { hold: existing.hold, writesBlocked: true, newlyPreserved: false }
  }
  // Publish the hold BEFORE touching the original. If the marker cannot be written the original stays
  // in place untouched; if we are interrupted after the move, the marker already names the backup.
  const target = await nextCorruptBackupPath(configPath, operations.stat)
  if (!target) {
    return { hold: existing.hold, writesBlocked: true, newlyPreserved: false }
  }
  const restorePriorMarkerAndResolveHold = async (): Promise<ConfigRecoveryOutcome> => {
    if (existing.rawMarker !== null) {
      const restoredMarker = await writeFileAtomic(markerPath, existing.rawMarker).then(() => true, () => false)
      if (!restoredMarker) {
        return { hold: existing.hold, writesBlocked: false, newlyPreserved: false }
      }
      return { hold: await activeConfigRecovery(markerPath, operations.stat), writesBlocked: false, newlyPreserved: false }
    }
    await rm(markerPath, { force: true }).catch(() => undefined)
    return { hold: null, writesBlocked: false, newlyPreserved: false }
  }
  const held = await beginConfigRecovery(markerPath, target).then(() => true, () => false)
  if (held) {
    // Revalidate immediately before moving: a settings restore may have completed while the existing hold,
    // candidate backup path, or recovery marker was being prepared.
    const preMoveProbe = await probeConfigFile(configPath)
    if (preMoveProbe.state === 'parseable' || preMoveProbe.state === 'missing') {
      return restorePriorMarkerAndResolveHold()
    }
    const preserved = await preserveUnreadableFile(
      configPath,
      { rename: operations.rename ?? rename, copyFile: operations.copyFile ?? copyFile },
      target,
    )
    if (preserved) {
      // Also check what landed in `preserved` in case a valid replacement arrived right at the move/copy boundary.
      const preservedProbe = await probeConfigFile(preserved)
      if (preservedProbe.state === 'parseable') {
        const restoredInPlace = await restorePreservedValidConfig(preserved, configPath)
        if (!restoredInPlace) {
          return { hold: preserved, writesBlocked: true, newlyPreserved: false }
        }
        return restorePriorMarkerAndResolveHold()
      }
      return { hold: preserved, writesBlocked: false, newlyPreserved: true }
    }
    // Nothing was preserved: the original is intact, so restore any prior marker hold or remove the new marker.
    if (existing.hold && existing.rawMarker !== null) {
      await writeFileAtomic(markerPath, existing.rawMarker).catch(() => undefined)
      return { hold: existing.hold, writesBlocked: true, newlyPreserved: false }
    }
    await rm(markerPath, { force: true }).catch(() => undefined)
  }
  return { hold: existing.hold, writesBlocked: true, newlyPreserved: false }
}
