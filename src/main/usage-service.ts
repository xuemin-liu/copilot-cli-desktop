import { Worker } from 'node:worker_threads'
import { withShutdownDeadline } from './shutdown-deadline.js'
import type { UsageReport, UsageScope, UsageFlushResult } from './usage-types.js'

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
  private state: 'running' | 'paused' | 'stopping' | 'closed' | 'unavailable' = 'running'
  private stopPromise: Promise<void> | null = null
  private collecting: Promise<void> | null = null
  private followupCollection: Promise<void> | null = null
  private lastCollectionError: string | null = null
  private writeVersion = 0
  private lastFlushedVersion = -1
  private flushing: { version: number; promise: Promise<void> } | null = null

  constructor(private readonly path: string, private readonly home: string, private readonly diagnostic: (message: string) => void, private readonly options: ServiceOptions = {}) {
    this.timer = setInterval(() => { if (this.state === 'running' && !this.flushing) void this.collect().catch((error) => diagnostic(String(error))) }, 30_000)
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
      this.state = 'unavailable'
      clearInterval(this.timer)
      for (const request of this.queue.splice(0)) request.reject(error)
    }
    this.restarting = withShutdownDeadline(worker.terminate(), this.options.shutdownTimeoutMs ?? 15_000).catch((failure: Error) => {
      this.unavailable = new Error('Usage worker could not stop; restart the app to retry. ' + failure.message)
      this.state = 'unavailable'
      clearInterval(this.timer)
      for (const request of this.queue.splice(0)) request.reject(this.unavailable)
    }).finally(() => {
      this.restarting = null
      this.pump()
    })
  }
  private pump(): void {
    if (this.state === 'closed' || this.unavailable || this.active || this.restarting || !this.queue.length) return
    if (!this.worker) {
      try { this.startWorker() } catch (error) {
        this.unavailable = error as Error
        this.state = 'unavailable'
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
  private admissionError(method: string, args: unknown[] = []): Error | null {
    if (this.unavailable) return this.unavailable
    if (this.state === 'closed' || (this.state === 'stopping' && method !== 'flush')) return new Error('Usage service is stopping')
    if (this.state === 'paused' && method !== 'flush' && !(method === 'report' && args[2] === undefined)) return new Error('Usage writes are paused for update installation')
    return null
  }
  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    const error = this.admissionError(method, args)
    if (error) return Promise.reject(error)
    if (['collect', 'associate', 'restore', 'export'].includes(method) || (method === 'report' && args[2] !== undefined)) this.writeVersion++
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.sequence, method, args, resolve, reject })
      this.pump()
    })
  }
  collect(): Promise<void> {
    const error = this.admissionError('collect')
    if (error) return Promise.reject(error)
    if (this.collecting) {
      return this.followupCollection ??= this.collecting.catch(() => {}).then(() => {
        this.followupCollection = null
        return this.collect()
      })
    }
    return this.collecting = this.call<UsageFlushResult | undefined>('collect')
      .then((result) => { this.lastCollectionError = result?.backupWarning ?? null }, (error: unknown) => { this.lastCollectionError = String(error); throw error })
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
  /** External session shutdown changes the source even if no ledger request was queued. */
  noteSourceChanged(): void { if (this.state !== 'closed') this.writeVersion++ }
  exportTo(path: string): Promise<void> { return this.call('export', path) }
  restoreFrom(path: string): Promise<void> { return this.call('restore', path) }
  pauseCollection(): void {
    const error = this.admissionError('flush')
    if (error) throw error
    if (this.state === 'running') this.state = 'paused'
  }
  resumeCollection(): void { if (this.state === 'paused') this.state = 'running' }
  flush(): Promise<void> {
    const error = this.admissionError('flush')
    if (error) return Promise.reject(error)
    if (this.flushing?.version === this.writeVersion) return this.flushing.promise
    // The flush includes a new scan. Join unsent collections to its result rather
    // than doing redundant scans/backups before the operation the caller needs.
    const superseded = this.queue.filter((request) => request.method === 'collect')
    this.queue = this.queue.filter((request) => request.method !== 'collect')
    const version = this.writeVersion
    let backupWarning: string | null = null
    const work = this.call<UsageFlushResult | undefined>('flush').then((result) => {
      backupWarning = result?.backupWarning ?? null
      this.lastCollectionError = backupWarning
      if (this.lastCollectionError) this.diagnostic(this.lastCollectionError)
      this.lastFlushedVersion = version
    }, (error: unknown) => {
      this.lastCollectionError = String(error); throw error
    }).finally(() => { if (this.flushing?.promise === work) this.flushing = null })
    this.flushing = { version, promise: work }
    for (const request of superseded) void work.then(() => request.resolve({ backupWarning }), (error: Error) => request.reject(error))
    return work
  }
  stop(): Promise<void> {
    return this.stopPromise ??= (async () => {
      const alreadyFlushed = this.state === 'paused' && this.lastFlushedVersion === this.writeVersion
      this.state = 'stopping'
      clearInterval(this.timer)
      try {
        const finalFlush = alreadyFlushed ? Promise.resolve() : this.flush()
        await withShutdownDeadline(finalFlush.finally(() => this.terminate()), this.options.shutdownTimeoutMs ?? 15_000)
      } finally { void this.terminate().catch(() => {}) }
    })()
  }
  abort(): Promise<void> {
    return withShutdownDeadline(this.terminate(), this.options.shutdownTimeoutMs ?? 15_000)
  }
  private terminate(): Promise<void> {
    if (this.termination) return this.termination
    this.state = 'closed'
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
