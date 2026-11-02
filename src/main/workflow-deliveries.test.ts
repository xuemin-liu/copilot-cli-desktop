import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowDeliveries } from './workflow-deliveries.js'
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
