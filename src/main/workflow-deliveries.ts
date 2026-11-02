import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { redactDiagnosticText } from './desktop-diagnostics.js'

export type DeliveryState = 'queued' | 'submitting' | 'submitted' | 'answered' | 'cancelled' | 'uncertain'
export interface WorkflowDelivery {
  id: string; sessionId: string; source: string; revision: string; scope: string; text: string; state: DeliveryState
}
const identifier = (value: string): boolean => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)
/** Rejected intake is not a corrupt/unavailable database. Existing recovery controls remain usable. */
export class WorkflowDeliveryRejected extends Error {}

/** Host-owned durable outbox. Callers must verify authorization and the live recipient again at submission. */
export class WorkflowDeliveries {
  private db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    try {
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      if (version !== 0 && version !== 1) throw new Error('Unsupported delivery schema')
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, session TEXT NOT NULL, source TEXT NOT NULL,
          revision TEXT NOT NULL, scope TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL,
          UNIQUE(session,source,revision,scope));
        CREATE UNIQUE INDEX IF NOT EXISTS one_submission ON deliveries(session)
          WHERE state IN ('submitting','submitted','uncertain');
        UPDATE deliveries SET state='uncertain' WHERE state IN ('submitting','submitted');
        PRAGMA user_version=1; COMMIT;`)
    } catch (error) { this.db.close(); throw error }
  }
  close(): void { this.db.close() }
  enqueue(input: Omit<WorkflowDelivery, 'id' | 'state'>): WorkflowDelivery {
    if (![input.sessionId,input.source,input.revision,input.scope].every(identifier) || typeof input.text !== 'string' || input.text.length > 12_000)
      throw new WorkflowDeliveryRejected('Invalid delivery')
    const body = redactDiagnosticText(input.text.replace(/[\p{Cf}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ''))
    if (body.length > 12_000) throw new WorkflowDeliveryRejected('Redacted delivery body exceeds the stored limit')
    const existing = this.db.prepare('SELECT id FROM deliveries WHERE session=? AND source=? AND revision=? AND scope=?')
      .get(input.sessionId,input.source,input.revision,input.scope) as {id: string} | undefined
    if (existing) return this.get(existing.id)!
    if ((this.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get() as {n: number}).n >= 1000) throw new WorkflowDeliveryRejected('Delivery history limit reached')
    const id = randomUUID()
    this.db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?)').run(id,input.sessionId,input.source,input.revision,input.scope,body,'queued')
    return this.get(id)!
  }
  get(id: string): WorkflowDelivery | null {
    const row = this.db.prepare('SELECT id,session AS sessionId,source,revision,scope,body AS text,state FROM deliveries WHERE id=?').get(id)
    return row ? this.decode(row) : null
  }
  list(): WorkflowDelivery[] {
    return this.db.prepare('SELECT id,session AS sessionId,source,revision,scope,body AS text,state FROM deliveries ORDER BY rowid').all().map(row => this.decode(row))
  }
  /** Commit intent before invoking anything that may type or execute. Uncertain/in-flight work blocks this destination. */
  begin(id: string, authorize: (delivery: WorkflowDelivery) => boolean): WorkflowDelivery | null {
    const delivery = this.get(id)
    if (!delivery || delivery.state !== 'queued' || !authorize(delivery)) return null
    if (this.db.prepare("SELECT id FROM deliveries WHERE session=? AND state IN ('submitting','submitted','uncertain')").get(delivery.sessionId)) return null
    const changed = this.db.prepare("UPDATE deliveries SET state='submitting' WHERE id=? AND state='queued'").run(id)
    return changed.changes ? this.get(id) : null
  }
  submitted(id: string): void { this.transition(id, 'submitting', 'submitted') }
  /** Only for a gate that proves no input was typed; exceptions or timeouts are not that proof. */
  notSubmitted(id: string): void { this.transition(id, 'submitting', 'queued') }
  uncertain(id: string): void {
    this.db.prepare("UPDATE deliveries SET state='uncertain' WHERE id=? AND state IN ('submitting','submitted')").run(id)
  }
  answered(id: string): void { this.transition(id, 'submitted', 'answered') }
  /** Person-only controls; never invoke from source text or a worker report. */
  retry(id: string): void { this.transition(id, 'uncertain', 'queued') }
  discard(id: string): void {
    const delivery = this.get(id)
    if (!delivery || !['queued','uncertain'].includes(delivery.state)) throw new Error('Delivery is not awaiting a decision')
    this.transition(id, delivery.state, 'cancelled')
  }
  cancelScope(scope: string): void {
    this.db.prepare("UPDATE deliveries SET state='cancelled' WHERE scope=? AND state='queued'").run(scope)
  }
  /** Host-only: the scope must be permanently disabled and must never be reused. Unresolved evidence is retained. */
  retireScope(scope: string): boolean {
    if(this.db.prepare("SELECT id FROM deliveries WHERE scope=? AND state NOT IN ('answered','cancelled')").get(scope))return false
    this.db.prepare("DELETE FROM deliveries WHERE scope=? AND state IN ('answered','cancelled')").run(scope)
    return true
  }
  private transition(id: string, from: DeliveryState, to: DeliveryState): void {
    if (!this.db.prepare('UPDATE deliveries SET state=? WHERE id=? AND state=?').run(to,id,from).changes) throw new Error('Delivery state changed')
  }
  private decode(value: unknown): WorkflowDelivery {
    const row = value as WorkflowDelivery
    if (!row || ![row.id,row.sessionId,row.source,row.revision,row.scope].every(identifier)
      || !['queued','submitting','submitted','answered','cancelled','uncertain'].includes(row.state)
      || typeof row.text !== 'string' || row.text.length > 12_000
      || redactDiagnosticText(row.text.replace(/[\p{Cf}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')) !== row.text) throw new Error('Invalid stored delivery')
    return row
  }
}
