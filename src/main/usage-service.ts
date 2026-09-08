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
  private unavailable: Error | null = null
  private termination: Promise<void> | null = null
  private closed = false
  private stopping = false
  private stopPromise: Promise<void> | null = null
  private collecting: Promise<void> | null = null
  private followupCollection: Promise<void> | null = null
  private lastCollectionError: string | null = null
  private paused = false
  private pauseVersion = 0
  private preparedForQuit = false
  private flushing: Promise<void> | null = null

  constructor(private readonly path: string, private readonly home: string, private readonly diagnostic: (message: string) => void, private readonly options: ServiceOptions = {}) {
    this.timer = setInterval(() => { if (!this.paused) void this.collect().catch((error) => diagnostic(String(error))) }, 30_000)
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
      if (message.error) request.reject(new Error(message.error))
      else {
        if (request.method === 'collect' || request.method === 'flush') this.restartAttempts = 0
        request.resolve(message.result)
      }
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
    // Stop automatic retries after repeated failures; restarting the app retries safely.
    if (++this.restartAttempts >= 3) {
      this.unavailable = new Error('Usage worker repeatedly failed; restart the app to retry. ' + error.message)
      clearInterval(this.timer)
      for (const request of this.queue.splice(0)) request.reject(error)
    }
    this.restarting = withShutdownDeadline(worker.terminate(), this.options.shutdownTimeoutMs ?? 15_000).catch((failure: Error) => {
      this.unavailable = new Error('Usage worker could not stop; restart the app to retry. ' + failure.message)
      clearInterval(this.timer)
      for (const request of this.queue.splice(0)) request.reject(this.unavailable)
    }).finally(() => {
      this.restarting = null
      this.pump()
    })
  }
  private pump(): void {
    if (this.closed || this.unavailable || this.active || this.restarting || !this.queue.length) return
    if (!this.worker) {
      try { this.startWorker() } catch (error) {
        this.unavailable = error as Error
        clearInterval(this.timer)
        for (const request of this.queue.splice(0)) request.reject(this.unavailable)
      }
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
    if (this.unavailable) return Promise.reject(this.unavailable)
    if (this.closed || (this.stopping && method !== 'flush')) return Promise.reject(new Error('Usage service is stopping'))
    if (['collect', 'associate', 'restore', 'export'].includes(method)) this.preparedForQuit = false
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.sequence, method, args, resolve, reject })
      this.pump()
    })
  }
  collect(): Promise<void> {
    if (this.paused) return this.flushing ?? Promise.reject(new Error('Usage collection is paused for update installation'))
    if (this.collecting) {
      return this.followupCollection ??= this.collecting.catch(() => {}).then(() => {
        this.followupCollection = null
        return this.collect()
      })
    }
    return this.collecting = this.call<void>('collect')
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
  pauseCollection(): void {
    this.paused = true
    this.pauseVersion++
    this.preparedForQuit = false
    // A flush requested before session shutdown cannot cover its final records.
    this.flushing = null
  }
  resumeCollection(): void { this.paused = false; this.preparedForQuit = false }
  flush(): Promise<void> {
    if (this.paused && this.flushing) return this.flushing
    // The flush includes a new scan. Join unsent collections to its result rather
    // than doing redundant scans/backups before the operation the caller needs.
    const superseded = this.queue.filter((request) => request.method === 'collect')
    this.queue = this.queue.filter((request) => request.method !== 'collect')
    const pauseVersion = this.pauseVersion
    const work = this.call<void>('flush').then(() => {
      this.lastCollectionError = null
      this.preparedForQuit = this.paused && pauseVersion === this.pauseVersion && !this.queue.length && !this.active
    }, (error: unknown) => {
      this.lastCollectionError = String(error); throw error
    }).finally(() => { if (this.flushing === work) this.flushing = null })
    this.flushing = work
    for (const request of superseded) void work.then(() => request.resolve(undefined), (error: Error) => request.reject(error))
    return work
  }
  stop(): Promise<void> {
    return this.stopPromise ??= (async () => {
      this.stopping = true
      clearInterval(this.timer)
      try {
        const finalFlush = this.preparedForQuit ? Promise.resolve() : this.flush()
        await withShutdownDeadline(finalFlush.finally(() => this.terminate()), this.options.shutdownTimeoutMs ?? 15_000)
      } finally { void this.terminate().catch(() => {}) }
    })()
  }
  abort(): Promise<void> {
    return withShutdownDeadline(this.terminate(), this.options.shutdownTimeoutMs ?? 15_000)
  }
  private terminate(): Promise<void> {
    if (this.termination) return this.termination
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
    return this.termination = Promise.all([worker?.terminate(), this.restarting]).then(() => {})
  }
}
