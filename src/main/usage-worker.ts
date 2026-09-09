import { parentPort, workerData } from 'node:worker_threads'
import { setTimeout } from 'node:timers/promises'
import { UsageLedger, UsageDatabaseVersionError, recoverUsageDatabase, isTransientUsageError } from './usage-ledger.js'
import type { UsageScope, UsageFlushResult } from './usage-types.js'

const { path, home } = workerData as { path: string; home: string }
let ledger: UsageLedger | null = null
async function openLedger(): Promise<UsageLedger> {
  for (let attempt = 0; ; attempt++) {
    try { return ledger ??= new UsageLedger(path) }
    catch (error) {
      if (!isTransientUsageError(error) || attempt >= 3) throw error
      await setTimeout(100 * 2 ** attempt)
    }
  }
}
async function collect(backup: 'daily' | 'forced' | 'none' = 'daily'): Promise<UsageFlushResult> {
  const value = await openLedger()
  await value.collect(home)
  if (backup !== 'none') value.tryBackup(backup === 'forced')
  return { backupWarning: value.backupWarning() }
}
let queue = Promise.resolve()
parentPort!.on('message', (message: { id: number; method: string; args: unknown[] }) => {
  queue = queue.then(async () => {
    parentPort!.postMessage({ id: message.id, type: 'started' })
    try {
      let recovered = false
      try { await openLedger() } catch (error) {
        // Never replace a locked or future-version ledger. Explicit restore may replace an
        // unavailable path after retries, retaining originals; permission failures still surface.
        const sqliteCode = ((error as { errcode?: number }).errcode ?? -1) & 255
        if (message.method !== 'restore' || error instanceof UsageDatabaseVersionError || [5, 6].includes(sqliteCode) || (error as { code?: string }).code === 'EBUSY') throw error
        recoverUsageDatabase(path, message.args[0] as string)
        ledger = new UsageLedger(path)
        recovered = true
      }
      let result: unknown
      switch (message.method) {
        case 'collect': result = await collect(); break
        case 'report': result = ledger!.report(message.args[0] as string, message.args[1] as UsageScope, message.args[2] as string | undefined); break
        case 'associate': ledger!.associate(message.args[0] as string, message.args[1] as boolean); break
        case 'export': await collect('none'); ledger!.exportTo(message.args[0] as string); break
        case 'restore': if (!recovered) ledger!.restoreFrom(message.args[0] as string); await collect(); break
        case 'flush': result = await collect('forced'); break
        default: throw new Error('Unknown usage operation')
      }
      parentPort!.postMessage({ id: message.id, result })
    } catch (error) { parentPort!.postMessage({ id: message.id, error: String(error) }) }
  })
})
parentPort!.postMessage({ type: 'ready' })
