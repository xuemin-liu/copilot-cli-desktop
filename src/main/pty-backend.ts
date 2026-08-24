/**
 * Common shape both pty backends implement, so `PtySession` (pty-session.ts)
 * does not need to know whether it is driving a real pty or a plain piped
 * child process.
 */
export interface PtyLike {
  readonly pid: number | undefined
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface SpawnOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  cols: number
  rows: number
}

export type SpawnPtyFn = (file: string, args: string[], options: SpawnOptions) => PtyLike | Promise<PtyLike>
