import { parentPort, workerData } from 'node:worker_threads'
import { UsageLedger, recoverUsageDatabase } from './usage-ledger.js'
import type { UsageScope } from './usage-types.js'

const { path, home } = workerData as { path: string; home: string }
let ledger: UsageLedger | null = null
let failure = ''
try { ledger = new UsageLedger(path) } catch (error) { failure = String(error) }
function collect(): void {
  if (!ledger) throw new Error(failure)
  ledger.collect(home)
  ledger.backup()
}
parentPort!.on('message', (message: { id: number; method: string; args: any[] }) => {
  try {
    if (!ledger && message.method === 'restore' && !failure.includes('Unsupported usage database version')) {
      recoverUsageDatabase(path, message.args[0] as string)
      ledger = new UsageLedger(path)
      ledger.collect(home)
      ledger.backup(true)
      parentPort!.postMessage({ id: message.id })
      return
    }
    if (!ledger) throw new Error(failure)
    let result: unknown
    switch (message.method) {
      case 'collect': collect(); break
      case 'report': result = ledger.report(message.args[0] as string, message.args[1] as UsageScope, message.args[2] as string | undefined); break
      case 'associate': ledger.associate(message.args[0] as string, message.args[1] as boolean); break
      case 'export': collect(); ledger.exportTo(message.args[0] as string); break
      case 'restore': ledger.restoreFrom(message.args[0] as string); collect(); break
      case 'flush': collect(); ledger.backup(true); break
      default: throw new Error('Unknown usage operation')
    }
    parentPort!.postMessage({ id: message.id, result })
  } catch (error) { parentPort!.postMessage({ id: message.id, error: String(error) }) }
})
