/** Electron wraps rejected IPC calls with transport details intended for logs. */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}
