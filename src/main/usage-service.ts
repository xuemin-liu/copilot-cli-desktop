import { Worker } from 'node:worker_threads'
import { withShutdownDeadline } from './shutdown-deadline.js'
import type { UsageReport, UsageScope } from './usage-types.js'

export interface UsageWorker {
  on(event: string, listener: (...args: any[]) => void): unknown
  postMessage(message: unknown): void
  terminate(): Promise<number>
}
interface Request {
  id: number
  method: string
  args: unknown[]
  resolve: (value: any) => void
  reject: (error: Error) => void
}
interface ServiceOptions {
  createWorker?: () => UsageWorker
  executionTimeoutMs?: number
  startupTimeoutMs?: number
  shutdownTimeoutMs?: number
}

/** Main-side queue: only the active operation has a deadline. Unsent calls survive worker replacement. */
export class UsageService {
  private worker: UsageWorker | null = null
  private ready = false
  private sequence = 0
  private queue: Request[] = []
  private active: Request | null = null
  private timer: NodeJS.Timeout
  private startupTimer: NodeJS.Timeout | undefined
  private operationTimer: NodeJS.Timeout | undefined
  private restarting: Promise<void> | null = null
  private restartAttempts = 0
  private closed = false
  private stopping = false
  private stopPromise: Promise<void> | null = null
  private collecting: Promise<void> | null = null
  private lastCollectionError: string | null = null

  constructor(private readonly path: string, private readonly home: string, private readonly diagnostic: (message: string) => void, private readonly options: ServiceOptions = {}) {
    this.timer = setInterval(() => { void this.collect().catch((error) => diagnostic(String(error))) }, 30_000)
    this.timer.unref()
    void this.collect().catch((error) => diagnostic(String(error)))
  }
  private startWorker(): void {
    const worker = this.options.createWorker?.() ?? new Worker(new URL('./usage-worker.js', import.meta.url), { workerData: { path: this.path, home: this.home } })
    this.worker = worker
    this.ready = false
    this.startupTimer = setTimeout(() => this.recycle(worker, new Error('Usage worker startup timed out')), this.options.startupTimeoutMs ?? 15_000)
    worker.on('message', (message: { id?: number; type?: string; result?: unknown; error?: string }) => {
      if (this.worker !== worker) return
      if (message.type === 'ready') {
        clearTimeout(this.startupTimer)
        this.ready = true
        this.pump()
        return
      }
      if (!this.active || message.id !== this.active.id) return
      if (message.type === 'started') {
        clearTimeout(this.operationTimer)
        this.operationTimer = setTimeout(() => this.recycle(worker, new Error('Usage operation timed out; collection will resume in a replacement worker.')), this.options.executionTimeoutMs ?? 120_000)
        return
      }
      clearTimeout(this.operationTimer)
      const request = this.active
      this.active = null
      this.restartAttempts = 0
      if (message.error) request.reject(new Error(message.error))
      else request.resolve(message.result)
      this.pump()
    })
    worker.on('error', (error: Error) => this.recycle(worker, error))
    worker.on('exit', () => this.recycle(worker, new Error('Usage worker exited unexpectedly; collection will resume.')))
  }
  private recycle(worker: UsageWorker, error: Error): void {
    if (this.worker !== worker) return
    this.worker = null
    this.ready = false
    clearTimeout(this.startupTimer)
    clearTimeout(this.operationTimer)
    this.active?.reject(error)
    this.active = null
    this.diagnostic(String(error))
    // Avoid endless bootstrap failures. A future collection will make a fresh attempt.
    if (++this.restartAttempts >= 3) {
      for (const request of this.queue.splice(0)) request.reject(error)
      this.restartAttempts = 0
    }
    this.restarting = worker.terminate().then(() => {}, () => {}).finally(() => {
      this.restarting = null
      this.pump()
    })
  }
  private pump(): void {
    if (this.closed || this.active || this.restarting || !this.queue.length) return
    if (!this.worker) {
      try { this.startWorker() } catch (error) { for (const request of this.queue.splice(0)) request.reject(error as Error) }
      return
    }
    if (!this.ready) return
    const worker = this.worker
    this.active = this.queue.shift()!
    // This is an acknowledgement watchdog, not time spent behind other operations.
    this.operationTimer = setTimeout(() => this.recycle(worker, new Error('Usage worker did not acknowledge its operation')), this.options.startupTimeoutMs ?? 15_000)
    try { worker.postMessage({ id: this.active.id, method: this.active.method, args: this.active.args }) }
    catch (error) { this.recycle(worker, error as Error) }
  }
  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.closed || (this.stopping && method !== 'flush')) return Promise.reject(new Error('Usage service is stopping'))
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.sequence, method, args, resolve, reject })
      this.pump()
    })
  }
  collect(): Promise<void> {
    return this.collecting ??= this.call<void>('collect')
      .then(() => { this.lastCollectionError = null }, (error: unknown) => { this.lastCollectionError = String(error); throw error })
      .finally(() => { this.collecting = null })
  }
  async report(month: string, scope: UsageScope, timezone?: string): Promise<UsageReport> {
    const report = await this.call<UsageReport>('report', month, scope, timezone)
    if (this.lastCollectionError) report.warnings.push('Collection or backup failed: ' + this.lastCollectionError)
    return report
  }
  associate(session: string, fork: boolean): void {
    void this.call('associate', session, fork).catch((error) => this.diagnostic(String(error)))
  }
  exportTo(path: string): Promise<void> { return this.call('export', path) }
  restoreFrom(path: string): Promise<void> { return this.call('restore', path) }
  flush(): Promise<void> { return this.call('flush') }
  stop(): Promise<void> {
    return this.stopPromise ??= (async () => {
      this.stopping = true
      clearInterval(this.timer)
      try { await withShutdownDeadline(this.flush(), this.options.shutdownTimeoutMs ?? 15_000) }
      finally { await this.abort() }
    })()
  }
  async abort(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    clearTimeout(this.startupTimer)
    clearTimeout(this.operationTimer)
    const error = new Error('Usage service stopped; committed usage is retained')
    this.active?.reject(error)
    this.active = null
    for (const request of this.queue.splice(0)) request.reject(error)
    const worker = this.worker
    this.worker = null
    await worker?.terminate()
    await this.restarting
  }
}
