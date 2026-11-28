import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { copyFile, readFile, rename, rm, stat } from 'node:fs/promises'
import { writeFileAtomic } from './atomic-file.js'

type PreserveOperations = { rename: typeof rename; copyFile: typeof copyFile }
export type RecoveryOperations = Partial<PreserveOperations> & {
  stat?: typeof stat
  writeMarker?: typeof writeFileAtomic
}

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

export interface ConfigRecoveryMarkerOptions {
  previousPreserved?: readonly string[]
  previousMarkerCorrupt?: boolean
}

/**
 * The recovery hold outlives the launch that detected the problem: while the
 * preserved file exists, data that only it references (browser profiles) must
 * not be pruned. Deleting or restoring the backup is the explicit
 * acknowledgement that releases the hold.
 */
export async function beginConfigRecovery(
  markerPath: string,
  preserved: string,
  options: ConfigRecoveryMarkerOptions = {},
  writeMarker: typeof writeFileAtomic = writeFileAtomic,
): Promise<void> {
  const previousPreserved = Array.from(new Set(
    (options.previousPreserved ?? []).filter((entry) => typeof entry === 'string' && entry.length > 0 && entry !== preserved),
  ))
  await writeMarker(
    markerPath,
    `${JSON.stringify({
      preserved,
      ...(previousPreserved.length > 0 ? { previousPreserved } : {}),
      ...(options.previousMarkerCorrupt ? { previousMarkerCorrupt: true } : {}),
      createdAt: new Date().toISOString(),
    })}\n`,
  )
}

interface RecoveryMarkerInspection {
  hold: string | null
  activeBackups: string[]
  rawMarker: string | null
  isDirectory: boolean
  markerReadError: boolean
  corruptMarker: boolean
  staleMarkerOnDisk: boolean
  needsCompaction: boolean
}

async function inspectRecoveryMarker(markerPath: string, statPath: typeof stat = stat): Promise<RecoveryMarkerInspection> {
  let rawMarker: string
  try {
    rawMarker = await readFile(markerPath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return { hold: null, activeBackups: [], rawMarker: null, isDirectory: false, markerReadError: false, corruptMarker: false, staleMarkerOnDisk: false, needsCompaction: false }
    }
    if (code === 'EISDIR') {
      return { hold: null, activeBackups: [], rawMarker: null, isDirectory: true, markerReadError: false, corruptMarker: false, staleMarkerOnDisk: false, needsCompaction: false }
    }
    // An unreadable marker is treated as an active hold: keeping data is the safe side.
    return { hold: markerPath, activeBackups: [], rawMarker: null, isDirectory: false, markerReadError: true, corruptMarker: false, staleMarkerOnDisk: false, needsCompaction: false }
  }
  let parsedValue: unknown
  try {
    parsedValue = JSON.parse(rawMarker) as unknown
  } catch {
    return { hold: markerPath, activeBackups: [], rawMarker, isDirectory: false, markerReadError: false, corruptMarker: true, staleMarkerOnDisk: false, needsCompaction: false }
  }
  if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
    return { hold: markerPath, activeBackups: [], rawMarker, isDirectory: false, markerReadError: false, corruptMarker: true, staleMarkerOnDisk: false, needsCompaction: false }
  }
  const parsed = parsedValue as { preserved?: unknown; previousPreserved?: unknown; previousMarkerCorrupt?: unknown }
  const primaryPreserved = typeof parsed.preserved === 'string' && parsed.preserved.length > 0 ? parsed.preserved : null
  const rawCandidates: string[] = []
  if (primaryPreserved) rawCandidates.push(primaryPreserved)
  if (typeof parsed.previousPreserved === 'string' && parsed.previousPreserved.length > 0) {
    rawCandidates.push(parsed.previousPreserved)
  } else if (Array.isArray(parsed.previousPreserved)) {
    for (const entry of parsed.previousPreserved) {
      if (typeof entry === 'string' && entry.length > 0) rawCandidates.push(entry)
    }
  }
  const candidates = Array.from(new Set(rawCandidates))
  const activeBackups: string[] = []
  for (const candidate of candidates) {
    try {
      await statPath(candidate)
      activeBackups.push(candidate)
    } catch (error) {
      // Only a confirmed missing backup means it was restored or deleted. EACCES/EPERM/I/O errors prove nothing.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        activeBackups.push(candidate)
      }
    }
  }
  const previousMarkerCorrupt = parsed.previousMarkerCorrupt === true
  if (activeBackups.length > 0) {
    const needsCompaction = activeBackups[0] !== primaryPreserved || activeBackups.length !== candidates.length
    return {
      hold: activeBackups[0]!,
      activeBackups,
      rawMarker,
      isDirectory: false,
      markerReadError: false,
      corruptMarker: previousMarkerCorrupt,
      staleMarkerOnDisk: false,
      needsCompaction,
    }
  }
  if (previousMarkerCorrupt) {
    return { hold: markerPath, activeBackups: [], rawMarker, isDirectory: false, markerReadError: false, corruptMarker: true, staleMarkerOnDisk: false, needsCompaction: false }
  }
  return { hold: null, activeBackups: [], rawMarker, isDirectory: false, markerReadError: false, corruptMarker: false, staleMarkerOnDisk: true, needsCompaction: false }
}

/** The preserved file path while a recovery hold is active, otherwise null (clearing a stale marker). */
export async function activeConfigRecovery(markerPath: string, statPath: typeof stat = stat): Promise<string | null> {
  const info = await inspectRecoveryMarker(markerPath, statPath)
  if (info.isDirectory) return markerPath
  if (info.staleMarkerOnDisk) {
    await rm(markerPath, { force: true }).catch(() => undefined)
    return null
  }
  if (info.needsCompaction && info.activeBackups.length > 0) {
    await beginConfigRecovery(markerPath, info.activeBackups[0]!, {
      previousPreserved: info.activeBackups.slice(1),
      previousMarkerCorrupt: info.corruptMarker,
    }).catch(() => undefined)
  }
  return info.hold
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
  const writeMarker = operations.writeMarker ?? writeFileAtomic
  if (unparseable) {
    const initialProbe = await probeConfigFile(configPath)
    if (initialProbe.state === 'parseable' || initialProbe.state === 'missing') {
      unparseable = false
    }
  }
  if (!unparseable) {
    return { hold: await activeConfigRecovery(markerPath, operations.stat), writesBlocked: false, newlyPreserved: false }
  }
  const existing = await inspectRecoveryMarker(markerPath, operations.stat)
  if (existing.markerReadError) {
    return { hold: existing.hold, writesBlocked: true, newlyPreserved: false }
  }
  // Publish the hold BEFORE touching the original, carrying forward any still-active prior backups inside
  // the provisional marker so a failed marker rollback cannot drop an earlier hold on the next launch.
  const target = await nextCorruptBackupPath(configPath, operations.stat)
  if (!target) {
    return { hold: existing.hold, writesBlocked: true, newlyPreserved: false }
  }
  const restorePriorMarkerAndResolve = async (writesBlocked: boolean): Promise<ConfigRecoveryOutcome> => {
    if (existing.rawMarker !== null && (existing.activeBackups.length > 0 || existing.corruptMarker)) {
      await writeMarker(markerPath, existing.rawMarker).catch(() => undefined)
    } else {
      await rm(markerPath, { force: true }).catch(() => undefined)
    }
    const current = await inspectRecoveryMarker(markerPath, operations.stat)
    if (current.staleMarkerOnDisk) {
      await rm(markerPath, { force: true }).catch(() => undefined)
      return { hold: null, writesBlocked, newlyPreserved: false }
    }
    return { hold: current.isDirectory ? null : current.hold, writesBlocked, newlyPreserved: false }
  }
  const held = await beginConfigRecovery(
    markerPath,
    target,
    { previousPreserved: existing.activeBackups, previousMarkerCorrupt: existing.corruptMarker },
    writeMarker,
  ).then(() => true, () => false)
  if (held) {
    // Revalidate immediately before moving: a settings restore may have completed while the existing hold,
    // candidate backup path, or recovery marker was being prepared.
    const preMoveProbe = await probeConfigFile(configPath)
    if (preMoveProbe.state === 'parseable' || preMoveProbe.state === 'missing') {
      return restorePriorMarkerAndResolve(false)
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
        return restorePriorMarkerAndResolve(false)
      }
      return { hold: preserved, writesBlocked: false, newlyPreserved: true }
    }
    return restorePriorMarkerAndResolve(true)
  }
  return { hold: existing.hold, writesBlocked: true, newlyPreserved: false }
}
