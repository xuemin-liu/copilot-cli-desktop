import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowDeliveries,makeDeliveryBatch,deliveryBatchIdentity } from './workflow-deliveries.js'
import {DatabaseSync} from 'node:sqlite'
import { spawnSync } from 'node:child_process'

test('restart preserves queued work, blocks uncertain resubmission, and retains source deduplication', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-deliveries-'))
  const path = join(dir, 'deliveries.sqlite')
  let store = new WorkflowDeliveries(path)
  const input = { sessionId:'session', source:'github/issue/1', revision:'r1', scope:'grant-1', text:'Review to\u200bken=fixture-secret' }
  try {
    const first = store.enqueue(input)
    assert.equal(first.text, 'Review token=[REDACTED]')
    assert.equal(store.enqueue({...input,text:'different body under the same version'}).id, first.id)
    const second = store.enqueue({...input,revision:'r2'})
    assert.equal(store.begin(first.id, () => false), null)
    assert.equal(store.begin(first.id, () => true)?.state, 'submitting')
    assert.equal(store.begin(second.id, () => true), null)
    store.close()
    store = new WorkflowDeliveries(path)
    assert.equal(store.get(first.id)?.state, 'uncertain')
    assert.equal(store.get(second.id)?.state, 'queued')
    assert.equal(store.begin(first.id, () => true), null)
    assert.equal(store.begin(second.id, () => true), null)
    store.retry(first.id)
    store.begin(first.id, () => true)
    store.notSubmitted(first.id)
    assert.equal(store.get(first.id)?.state, 'queued')
    store.begin(first.id, () => true)
    store.submitted(first.id)
    store.close()
    store = new WorkflowDeliveries(path)
    assert.equal(store.get(first.id)?.state, 'uncertain')
    store.discard(first.id)
    store.begin(second.id, () => true)
    store.submitted(second.id)
    store.answered(second.id)
    assert.equal(store.get(second.id)?.state, 'answered')
    assert.throws(() => store.retry(second.id), /state changed/)
    store.close()
    store = new WorkflowDeliveries(path)
    assert.equal(store.enqueue(input).state, 'cancelled')
    assert.equal((await readFile(path)).includes(Buffer.from('fixture-secret')), false)
  } finally { store.close(); await rm(dir, {recursive:true,force:true}) }
})

test('abrupt exit after committing intent never permits an automatic second submission', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-crash-'))
  const path = join(dir, 'deliveries.sqlite')
  const moduleUrl = new URL('./workflow-deliveries.js', import.meta.url).href
  try {
    const script = `import {WorkflowDeliveries} from ${JSON.stringify(moduleUrl)};
      const store=new WorkflowDeliveries(process.argv[1]);
      const item=store.enqueue({sessionId:'session',source:'github/1',revision:'r1',scope:'grant',text:'Fix the issue'});
      store.begin(item.id,()=>true); process.exit(17);`
    const result = spawnSync(process.execPath, ['--input-type=module','-e',script,path], { encoding:'utf8', windowsHide:true, timeout:10_000 })
    assert.equal(result.status, 17, result.stderr)
    const restored = new WorkflowDeliveries(path)
    try {
      const item = restored.list()[0]!
      assert.equal(item.state, 'uncertain')
      assert.equal(restored.begin(item.id, () => true), null)
    } finally { restored.close() }
  } finally { await rm(dir,{recursive:true,force:true}) }
})

test('redaction expansion is rejected without poisoning existing records or restart recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-expanded-'))
  const path = join(dir,'deliveries.sqlite')
  let store = new WorkflowDeliveries(path)
  try {
    const input = {sessionId:'session',source:'github/1',revision:'r1',scope:'grant',text:'Ordinary feedback'}
    const item = store.enqueue(input)
    assert.throws(() => store.enqueue({...input,revision:'expanded',text:'token=x '.repeat(1000)}))
    assert.equal(store.list().length,1)
    store.begin(item.id,() => true)
    store.close()
    store = new WorkflowDeliveries(path)
    assert.equal(store.list().length,1)
    assert.equal(store.get(item.id)?.state,'uncertain')
    store.discard(item.id)
    assert.equal(store.enqueue({...input,revision:'r2'}).state,'queued')
  } finally {store.close();await rm(dir,{recursive:true,force:true})}
})

test('legacy delivery migration preserves a readable backup and uncertain recovery',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'workflow-delivery-migration-')),path=join(dir,'deliveries.sqlite')
  const legacy=new DatabaseSync(path)
  legacy.exec('CREATE TABLE deliveries(id TEXT PRIMARY KEY,session TEXT NOT NULL,source TEXT NOT NULL,revision TEXT NOT NULL,scope TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,UNIQUE(session,source,revision,scope));PRAGMA user_version=1')
  legacy.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?)').run('legacy','session','meeting/m1/message','v1','meeting/m1','Legacy material','submitted');legacy.close()
  const store=new WorkflowDeliveries(path)
  try{
    assert.equal(store.get('legacy')?.state,'uncertain');assert.equal(store.get('legacy')?.batch,undefined)
    const backup=new DatabaseSync(path+'.pre-v2.sqlite')
    try{assert.equal((backup.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,1);assert.equal((backup.prepare('SELECT state FROM deliveries WHERE id=?').get('legacy') as {state:string}).state,'submitted')}finally{backup.close()}
  }finally{store.close();await rm(dir,{recursive:true,force:true})}
})

test('batch replacement is atomic, preserves its reservation, and cannot replay submitted work',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'workflow-batch-journal-')),path=join(dir,'deliveries.sqlite'),store=new WorkflowDeliveries(path)
  const head='a'.repeat(40),batch=makeDeliveryBatch(head,[{source:'github/review/1',version:'b'.repeat(64)},{source:'github/review/2',version:'c'.repeat(64)}])
  const input={sessionId:'session',scope:'grant',text:'Original',batch,...deliveryBatchIdentity(batch)}
  try{
    const old=store.enqueue(input),smaller=makeDeliveryBatch(head,[batch.members[1]!],batch.reservation)
    const replacement={...input,batch:smaller,...deliveryBatchIdentity(smaller),text:'Still current feedback'}
    assert.throws(()=>store.reconcileBatch(old.id,{...replacement,text:'x'.repeat(12001)},()=>true))
    assert.equal(store.get(old.id)?.state,'queued');assert.equal(store.list().length,1)
    assert.equal(store.reconcileBatch(old.id,replacement,()=>false),null)
    const next=store.reconcileBatch(old.id,replacement,()=>true)!
    assert.equal(store.get(old.id)?.state,'cancelled');assert.equal(next.batch?.reservation,batch.reservation)
    const copy=store.list();copy[1]!.batch!.members[0]!.version='d'.repeat(64)
    assert.equal(store.list()[1]!.batch?.members[0]?.version,'c'.repeat(64),'cached views are isolated')
    store.begin(next.id,()=>true);store.submitted(next.id)
    assert.equal(store.reconcileBatch(next.id,input,()=>true),null)
    const writer=new DatabaseSync(path)
    try{writer.prepare('UPDATE deliveries SET batch=? WHERE id=?').run('{}',next.id);assert.throws(()=>store.list(),/batch/)}finally{writer.close()}
  }finally{store.close();await rm(dir,{recursive:true,force:true})}
})

test('a batch committed before abrupt exit restores its membership and uncertain intent',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'workflow-batch-crash-')),path=join(directory,'journal.sqlite')
  try{
    const moduleUrl=new URL('./workflow-deliveries.js',import.meta.url).href
    const script=`import {WorkflowDeliveries,makeDeliveryBatch,deliveryBatchIdentity} from ${JSON.stringify(moduleUrl)};const journal=new WorkflowDeliveries(process.argv[1]);const batch=makeDeliveryBatch('${'a'.repeat(40)}',[{source:'github/review/1',version:'${'b'.repeat(64)}'}]);const item=journal.enqueue({sessionId:'session',scope:'scope',text:'Batch material',batch,...deliveryBatchIdentity(batch)});journal.begin(item.id,()=>true);process.exit(17);`
    const result=spawnSync(process.execPath,['--input-type=module','-e',script,path],{encoding:'utf8',windowsHide:true,timeout:10000})
    assert.equal(result.status,17,result.stderr)
    const restored=new WorkflowDeliveries(path)
    try{const item=restored.list()[0]!;assert.equal(item.state,'uncertain');assert.equal(item.batch?.members[0]?.source,'github/review/1');assert.equal(restored.begin(item.id,()=>true),null)}finally{restored.close()}
  }finally{await rm(directory,{recursive:true,force:true})}
})
