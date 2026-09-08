import { parentPort, workerData } from 'node:worker_threads'
import { setTimeout } from 'node:timers/promises'
import { UsageLedger, UsageDatabaseVersionError, recoverUsageDatabase, isTransientUsageError } from './usage-ledger.js'
import type { UsageScope } from './usage-types.js'

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
async function collect(): Promise<void> {
  const value = await openLedger()
  await value.collect(home)
  value.backup()
}
let queue = Promise.resolve()
parentPort!.on('message', (message: { id: number; method: string; args: unknown[] }) => {
  queue = queue.then(async () => {
    parentPort!.postMessage({ id: message.id, type: 'started' })
    try {
      let recovered = false
      try { await openLedger() } catch (error) {
        if (message.method !== 'restore' || error instanceof UsageDatabaseVersionError || isTransientUsageError(error)) throw error
        recoverUsageDatabase(path, message.args[0] as string)
        ledger = new UsageLedger(path)
        recovered = true
      }
      let result: unknown
      switch (message.method) {
        case 'collect': await collect(); break
        case 'report': result = ledger!.report(message.args[0] as string, message.args[1] as UsageScope, message.args[2] as string | undefined); break
        case 'associate': ledger!.associate(message.args[0] as string, message.args[1] as boolean); break
        case 'export': await collect(); ledger!.exportTo(message.args[0] as string); break
        case 'restore': if (!recovered) ledger!.restoreFrom(message.args[0] as string); await collect(); break
        case 'flush': await collect(); ledger!.backup(true); break
        default: throw new Error('Unknown usage operation')
      }
      parentPort!.postMessage({ id: message.id, result })
    } catch (error) { parentPort!.postMessage({ id: message.id, error: String(error) }) }
  })
})
parentPort!.postMessage({ type: 'ready' })
