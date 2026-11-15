import type { BrowserWindow } from 'electron'
import type { PtyLike } from '../../src/main/pty-backend.js'
declare class MyTerminalServices {
  constructor(directory: string, owner: () => BrowserWindow | null)
  invoke(method: string, args: unknown[], owns: (id: string) => boolean): Promise<unknown>
  authorizeDrop(paths: string[]): void
  spawn(id: string, connectionId: string, signal: AbortSignal): Promise<PtyLike>
  started(id: string): Promise<unknown> | undefined
  output(id: string, data: string): void
  closed(id: string): void
  dispose(): void
}
export = MyTerminalServices
