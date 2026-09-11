import { getCliPaths, readDaemonState, type DaemonState } from '../cli/runtime-state.js'
import { isDaemonAlive } from '../cli/control-client.js'

/** Authenticate the controller for this CLI home; process names/PIDs are not identities. */
export async function assertMigrationWritersStopped(deps = {
  readState: (): Promise<DaemonState | null> => readDaemonState(getCliPaths()),
  isAlive: isDaemonAlive,
}): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Migration currently supports Windows to Windows only')
  const daemon = await deps.readState()
  if (daemon && await deps.isAlive(daemon)) throw new Error('Stop the background controller with copilot-desktop stop before migration.')
  // External CLI sessions cannot be identified reliably by executable name.
  // Users must close them; snapshot and destination fingerprints detect writes.
}
