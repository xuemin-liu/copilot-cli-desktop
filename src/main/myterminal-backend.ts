import managerSource from '../../vendor/myterminal/electron/local-terminal.js'
import type { PtyLike, SpawnOptions, SpawnPtyFn } from './pty-backend.js'

interface Manager {
  processes: Map<string, { proc: PtyLike }>
  _emit(event: string, channel: string, value?: unknown): void
  spawn(id: string, options: { cols: number; rows: number }, host: {
    cwd: string; env: NodeJS.ProcessEnv; launch: { file: string; args: string[] }; spawn: SpawnPtyFn
  }): Promise<unknown>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  disconnect(id: string, signal?: string): void
}
const source = managerSource as { constructor: new () => Manager }

/** MyTerminal owns shell resolution, process I/O and resizing. This adapter supplies
 * the desktop's trusted cwd/environment and native watchdog (also used by CLI sessions). */
export async function spawnMyTerminal(spawn: SpawnPtyFn, file: string, args: string[], options: SpawnOptions): Promise<PtyLike> {
  const manager = new source.constructor()
  const id = 'terminal'
  const buffered: string[] = []
  let dataListener: ((data: string) => void) | undefined
  let exitListener: ((event: { exitCode: number }) => void) | undefined
  let exit: { exitCode: number } | undefined
  manager._emit = (event, _channel, value) => {
    if (event === 'ssh:data') { if (dataListener) dataListener(String(value)); else buffered.push(String(value)) }
    if (event === 'ssh:close') { exit = value as { exitCode: number } ?? { exitCode: 0 }; exitListener?.(exit) }
  }
  await manager.spawn(id, { cols: options.cols, rows: options.rows }, {
    cwd: options.cwd, env: options.env, launch: { file, args },
    spawn: (shell, argv, settings) => spawn(shell, argv, { ...settings, signal: options.signal }),
  })
  const native = manager.processes.get(id)?.proc
  return {
    pid: native?.pid,
    onData(listener) { dataListener = listener; for (const data of buffered.splice(0)) listener(data) },
    onExit(listener) { exitListener = listener; if (exit) listener(exit) },
    write(data) { manager.write(id, data) },
    resize(cols, rows) { manager.resize(id, cols, rows) },
    kill(signal) { manager.disconnect(id, signal) },
    dispose() { native?.dispose?.() },
  }
}
