import { getCliPaths, isProcessAlive, readDaemonState, type DaemonState } from '../cli/runtime-state.js'
import { isDaemonAlive } from '../cli/control-client.js'

/** Authenticate the controller; an ambiguous live PID remains blocked with a stale-state remedy. */
export async function assertMigrationWritersStopped(deps = {
  readState: (): Promise<DaemonState | null> => readDaemonState(getCliPaths()),
  isAlive: isDaemonAlive,
  processAlive: isProcessAlive,
}): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Migration currently supports Windows to Windows only')
  const daemon = await deps.readState()
  if (daemon && await deps.isAlive(daemon)) throw new Error('Stop the background controller with copilot-desktop stop before migration.')
  if (daemon && deps.processAlive(daemon.pid)) throw new Error(`The controller status could not be verified for saved PID ${daemon.pid}. Its PID may have been reused. Inspect ${getCliPaths().statePath}. If you have verified that this controller and its Copilot child are stopped, move that stale state file aside and retry. Do not stop an unrelated process solely because its PID matches.`)
  // External CLI sessions cannot be identified reliably by executable name.
  // Users must close them; snapshot and destination fingerprints detect writes.
}
