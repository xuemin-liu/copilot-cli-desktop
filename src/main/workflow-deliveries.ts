import { DatabaseSync } from 'node:sqlite'
import { randomUUID,createHash } from 'node:crypto'
import {existsSync} from 'node:fs'
import { redactDiagnosticText } from './desktop-diagnostics.js'

export type DeliveryState = 'queued' | 'submitting' | 'submitted' | 'answered' | 'cancelled' | 'uncertain'
export interface DeliveryBatch {reservation:string;head:string;members:{source:string;version:string}[]}
export interface WorkflowDelivery {
  batch?:DeliveryBatch;
  id: string; sessionId: string; source: string; revision: string; scope: string; text: string; state: DeliveryState
}
const identifier = (value: string): boolean => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)
function validBatch(value:unknown):DeliveryBatch{
  const batch=value as DeliveryBatch
  if(!batch||typeof batch!=='object'||Array.isArray(batch)||Object.keys(batch).some(key=>!['reservation','head','members'].includes(key))
    ||typeof batch.reservation!=='string'||!/^[a-f0-9]{64}$/.test(batch.reservation)||typeof batch.head!=='string'||!/^[a-f0-9]{40,64}$/.test(batch.head)||!Array.isArray(batch.members)||batch.members.length<1||batch.members.length>10
    ||!batch.members.every(member=>member&&typeof member==='object'&&!Array.isArray(member)&&Object.keys(member).every(key=>['source','version'].includes(key))
      &&identifier(member.source)&&member.source.startsWith('github/')&&!member.source.startsWith('github/batch/')&&typeof member.version==='string'&&/^[a-f0-9]{64}$/.test(member.version))
    ||new Set(batch.members.map(member=>member.source)).size!==batch.members.length)throw new Error('Invalid delivery batch')
  return {reservation:batch.reservation,head:batch.head,members:batch.members.map(member=>({source:member.source,version:member.version})).sort((a,b)=>a.source<b.source?-1:a.source>b.source?1:0)}
}
export function makeDeliveryBatch(head:string,members:DeliveryBatch['members'],reservation?:string):DeliveryBatch{
  const normalized=validBatch({head,members,reservation:reservation??'0'.repeat(64)})
  return {...normalized,reservation:reservation??createHash('sha256').update(JSON.stringify({head,members:normalized.members})).digest('hex')}
}
export function deliveryBatchIdentity(value:DeliveryBatch):{source:string;revision:string}{
  const batch=validBatch(value),hash=createHash('sha256').update(JSON.stringify(batch)).digest('hex')
  return {source:`github/batch/${hash}`,revision:`${batch.head}/${hash}`}
}
/** Rejected intake is not a corrupt/unavailable database. Existing recovery controls remain usable. */
export class WorkflowDeliveryRejected extends Error {}

/** Host-owned durable outbox. Callers must verify authorization and the live recipient again at submission. */
export class WorkflowDeliveries {
  private db: DatabaseSync
  private cached:WorkflowDelivery[]|null=null
  private cachedVersion=-1
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    try {
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      if (version !== 0 && version !== 1 && version !== 2) throw new Error('Unsupported delivery schema')
      if(version===1&&!existsSync(path+'.pre-v2.sqlite'))this.db.prepare('VACUUM INTO ?').run(path+'.pre-v2.sqlite')
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, session TEXT NOT NULL, source TEXT NOT NULL,
          revision TEXT NOT NULL, scope TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL, batch TEXT,
          UNIQUE(session,source,revision,scope));
        `)
      if(version===1)this.db.exec('ALTER TABLE deliveries ADD COLUMN batch TEXT')
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_submission ON deliveries(session)
          WHERE state IN ('submitting','submitted','uncertain');
        UPDATE deliveries SET state='uncertain' WHERE state IN ('submitting','submitted');
        PRAGMA user_version=2; COMMIT;`)
    } catch (error) { this.db.close(); throw error }
  }
  close(): void { this.db.close() }
  enqueue(input: Omit<WorkflowDelivery, 'id' | 'state'>): WorkflowDelivery {
    if (![input.sessionId,input.source,input.revision,input.scope].every(identifier) || typeof input.text !== 'string' || input.text.length > 12_000)
      throw new WorkflowDeliveryRejected('Invalid delivery')
    const body = redactDiagnosticText(input.text.replace(/[\p{Cf}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ''))
    if (body.length > 12_000) throw new WorkflowDeliveryRejected('Redacted delivery body exceeds the stored limit')
    let batch:DeliveryBatch|undefined
    try{
      if(input.batch!==undefined){batch=validBatch(input.batch);const identity=deliveryBatchIdentity(batch);if(identity.source!==input.source||identity.revision!==input.revision)throw new Error('Invalid batch identity')}
      else if(input.source.startsWith('github/batch/'))throw new Error('Missing batch metadata')
    }catch{throw new WorkflowDeliveryRejected('Invalid delivery batch')}
    const existing = this.db.prepare('SELECT id FROM deliveries WHERE session=? AND source=? AND revision=? AND scope=?')
      .get(input.sessionId,input.source,input.revision,input.scope) as {id: string} | undefined
    if (existing) return this.get(existing.id)!
    if ((this.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get() as {n: number}).n >= 1000) throw new WorkflowDeliveryRejected('Delivery history limit reached')
    const id = randomUUID()
    this.db.prepare('INSERT INTO deliveries(id,session,source,revision,scope,body,state,batch) VALUES(?,?,?,?,?,?,?,?)').run(id,input.sessionId,input.source,input.revision,input.scope,body,'queued',batch?JSON.stringify(batch):null)
    this.cached=null
    return this.get(id)!
  }
  get(id: string): WorkflowDelivery | null {
    const row = this.db.prepare('SELECT id,session AS sessionId,source,revision,scope,body AS text,state,batch FROM deliveries WHERE id=?').get(id)
    return row ? this.decode(row) : null
  }
  list(): WorkflowDelivery[] {
    const version=(this.db.prepare('PRAGMA data_version').get() as {data_version:number}).data_version
    if(!this.cached||this.cachedVersion!==version){this.cached=this.db.prepare('SELECT id,session AS sessionId,source,revision,scope,body AS text,state,batch FROM deliveries ORDER BY rowid').all().map(row=>this.decode(row));this.cachedVersion=version}
    return structuredClone(this.cached)
  }
  /** Replace only proven unsubmitted batch work; identity/scope and both row writes commit together. */
  reconcileBatch(id:string,input:Omit<WorkflowDelivery,'id'|'state'>,authorize:()=>boolean):WorkflowDelivery|null{
    this.db.exec('BEGIN IMMEDIATE')
    try{
      const old=this.get(id)
      if(!old||old.state!=='queued'||!old.batch||!input.batch||old.batch.head!==input.batch.head||old.batch.reservation!==input.batch.reservation
        ||old.scope!==input.scope||old.sessionId!==input.sessionId||!authorize()){this.db.exec('COMMIT');return null}
      if(this.get(id)?.state!=='queued'){this.db.exec('COMMIT');return null}
      const next=this.enqueue(input)
      if(next.id!==old.id)this.transition(old.id,'queued','cancelled')
      this.db.exec('COMMIT');return next
    }catch(error){this.db.exec('ROLLBACK');throw error}
  }
  /** Commit intent before invoking anything that may type or execute. Uncertain/in-flight work blocks this destination. */
  begin(id: string, authorize: (delivery: WorkflowDelivery) => boolean): WorkflowDelivery | null {
    const delivery = this.get(id)
    if (!delivery || delivery.state !== 'queued' || !authorize(delivery)) return null
    if (this.db.prepare("SELECT id FROM deliveries WHERE session=? AND state IN ('submitting','submitted','uncertain')").get(delivery.sessionId)) return null
    const changed = this.db.prepare("UPDATE deliveries SET state='submitting' WHERE id=? AND state='queued'").run(id)
    if(changed.changes)this.cached=null
    return changed.changes ? this.get(id) : null
  }
  submitted(id: string): void { this.transition(id, 'submitting', 'submitted') }
  /** Only for a gate that proves no input was typed; exceptions or timeouts are not that proof. */
  notSubmitted(id: string): void { this.transition(id, 'submitting', 'queued') }
  uncertain(id: string): void {
    this.db.prepare("UPDATE deliveries SET state='uncertain' WHERE id=? AND state IN ('submitting','submitted')").run(id);this.cached=null
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
    this.db.prepare("UPDATE deliveries SET state='cancelled' WHERE scope=? AND state='queued'").run(scope);this.cached=null
  }
  /** Host-only: the scope must be permanently disabled and must never be reused. Unresolved evidence is retained. */
  retireScope(scope: string): boolean {
    if(this.db.prepare("SELECT id FROM deliveries WHERE scope=? AND state NOT IN ('answered','cancelled')").get(scope))return false
    this.db.prepare("DELETE FROM deliveries WHERE scope=? AND state IN ('answered','cancelled')").run(scope);this.cached=null
    return true
  }
  private transition(id: string, from: DeliveryState, to: DeliveryState): void {
    if (!this.db.prepare('UPDATE deliveries SET state=? WHERE id=? AND state=?').run(to,id,from).changes) throw new Error('Delivery state changed')
    this.cached=null
  }
  private decode(value: unknown): WorkflowDelivery {
    const row = value as Omit<WorkflowDelivery,'batch'>&{batch:string|null}
    if (!row || ![row.id,row.sessionId,row.source,row.revision,row.scope].every(identifier)
      || !['queued','submitting','submitted','answered','cancelled','uncertain'].includes(row.state)
      || typeof row.text !== 'string' || row.text.length > 12_000
      || redactDiagnosticText(row.text.replace(/[\p{Cf}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')) !== row.text) throw new Error('Invalid stored delivery')
    const {batch:stored,...delivery}=row
    if(stored!==null&&typeof stored!=='string')throw new Error('Invalid stored batch metadata')
    if(stored!==null){
      const batch=validBatch(JSON.parse(stored)),identity=deliveryBatchIdentity(batch)
      if(identity.source!==row.source||identity.revision!==row.revision)throw new Error('Invalid stored batch identity')
      return {...delivery,batch}
    }
    if(row.source.startsWith('github/batch/'))throw new Error('Missing stored batch metadata')
    return delivery
  }
}
