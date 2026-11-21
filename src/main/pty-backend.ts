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
  /** Release native/process handles after either natural exit or termination. */
  dispose?(): void
  /**
   * For a backend that learns only later whether the program started: settles when it has, or rejects with why it
   * could not (a missing program or folder). A backend whose spawn already failed or succeeded leaves it out.
   */
  readonly ready?: Promise<void>
}

export interface SpawnOptions {
  worktreeTimeoutMinutes?: number | undefined
  signal?: AbortSignal | undefined
  cwd: string
  env: NodeJS.ProcessEnv
  cols: number
  rows: number
}

export type SpawnPtyFn = (file: string, args: string[], options: SpawnOptions) => PtyLike | Promise<PtyLike>
