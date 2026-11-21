/** How often a window's page may be loaded again after its process ended, within a period. */
export class ReloadBudget {
  private readonly taken: number[] = []

  constructor(
    private readonly limit = 3,
    private readonly periodMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when one more reload is allowed; a page that keeps dying must not reload forever. */
  take(): boolean {
    const time = this.now()
    while (this.taken.length > 0 && time - this.taken[0]! >= this.periodMs) this.taken.shift()
    if (this.taken.length >= this.limit) return false
    this.taken.push(time)
    return true
  }
}

const MAX_DETAIL = 4000

function bounded(text: string): string {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}… [cut]` : text
}

/** One log line's worth of why a page or helper process ended. Takes only the known fields, as words and numbers. */
export function describeProcessExit(details: unknown): string {
  const record = (details ?? {}) as Record<string, unknown>
  const parts: string[] = []
  for (const key of ['type', 'name', 'serviceName', 'reason'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value) parts.push(`${key}=${value.replace(/[^\w .:-]/g, '?').slice(0, 80)}`)
  }
  if (typeof record.exitCode === 'number') parts.push(`exitCode=${record.exitCode}`)
  return parts.join(' ') || 'no details'
}

/** An error as text for the log: its stack when it has one. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return bounded(error.stack || `${error.name}: ${error.message}`)
  try { return bounded(typeof error === 'string' ? error : JSON.stringify(error) ?? String(error)) } catch { return bounded(String(error)) }
}

interface ProcessEvents {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown
  on(event: 'uncaughtExceptionMonitor', listener: (error: unknown, origin: string) => void): unknown
}

/**
 * Record failures nothing handled. This only observes: `uncaughtExceptionMonitor` runs before the usual handling and does
 * not replace it, and the rejection is printed as before, so what the app does next is unchanged.
 */
export function observeProcessFailures(target: ProcessEvents, log: (line: string) => void, print: (line: string) => void): void {
  target.on('unhandledRejection', (reason) => {
    const line = `Unhandled promise rejection: ${describeError(reason)}`
    print(line)
    log(line)
  })
  target.on('uncaughtExceptionMonitor', (error, origin) => {
    log(`Fatal error (${origin}): ${describeError(error)}`)
  })
}
