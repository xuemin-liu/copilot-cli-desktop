import { Worker } from 'node:worker_threads'
import type { UsageReport, UsageScope } from './usage-types.js'

/** Serial worker owns SQLite; bounded requests cannot hold the Electron quit path indefinitely. */
export class UsageService {
  private worker: Worker
  private sequence = 0
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private timer: NodeJS.Timeout
  private collecting: Promise<void> | null = null
  private lastCollectionError: string | null = null
  private failure: Error | null = null

  constructor(path: string, home: string, private readonly diagnostic: (message: string) => void) {
    this.worker = new Worker(new URL('./usage-worker.js', import.meta.url), { workerData: { path, home } })
    this.worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
      const request = this.pending.get(message.id)
      if (!request) return
      clearTimeout(request.timer)
      this.pending.delete(message.id)
      if (message.error) request.reject(new Error(message.error))
      else request.resolve(message.result)
    })
    this.worker.on('error', (error) => this.fail(error))
    this.worker.on('exit', () => this.fail(new Error('Usage collection worker stopped; restart the app to resume collection. Saved usage is retained.')))
    this.timer = setInterval(() => { void this.collect().catch((error) => diagnostic(String(error))) }, 30_000)
    this.timer.unref()
    void this.collect().catch((error) => diagnostic(String(error)))
  }
  private fail(error: Error): void {
    this.failure = error
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error) }
    this.pending.clear()
  }
  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => {
        const error = new Error('Usage operation timed out. Saved transactions are retained; restart the app to resume collection.')
        this.fail(error)
        void this.worker.terminate()
      }, 15_000)
      this.pending.set(id, { resolve, reject, timer })
      this.worker.postMessage({ id, method, args })
    })
  }
  collect(): Promise<void> {
    return this.collecting ??= this.call<void>('collect')
      .then(() => { this.lastCollectionError = null }, (error: unknown) => { this.lastCollectionError = String(error); throw error })
      .finally(() => { this.collecting = null })
  }
  async report(month: string, scope: UsageScope, timezone?: string): Promise<UsageReport> {
    const report = await this.call<UsageReport>('report', month, scope, timezone)
    if (this.lastCollectionError) report.warnings.push(`Collection or backup failed: ${this.lastCollectionError}`)
    return report
  }
  associate(session: string, fork: boolean): void {
    void this.call('associate', session, fork).catch((error) => this.diagnostic(String(error)))
  }
  exportTo(path: string): Promise<void> { return this.call('export', path) }
  restoreFrom(path: string): Promise<void> { return this.call('restore', path) }
  flush(): Promise<void> { return this.call('flush') }
  async stop(): Promise<void> {
    clearInterval(this.timer)
    try { await this.flush() } finally { await this.worker.terminate() }
  }
}
