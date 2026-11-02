import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {githubBatchInput} from './workflow-feedback-batch.js'
import {WorkflowDeliveries} from './workflow-deliveries.js'
test('batch excerpts redact before truncation, retain source versions and fit the stored limit',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'workflow-batch-text-')),journal=new WorkflowDeliveries(join(directory,'journal.sqlite'))
  try{
    const events=Array.from({length:10},(_,n)=>({source:'github/'+String(n)+'x'.repeat(235),version:'b'.repeat(64),actorId:7,kind:'review' as const,head:'a'.repeat(40),at:1,body:'to\u200bken=fixture-secret '.repeat(1000)}))
    const input=githubBatchInput('session','scope','Original scope '.repeat(300),'a'.repeat(40),events),stored=journal.enqueue(input)
    assert.ok(stored.text.length<=12000);assert.doesNotMatch(stored.text,/fixture-secret/)
    assert.equal(stored.batch?.members.length,10)
    assert.equal(githubBatchInput('session','scope','Other text','a'.repeat(40),[...events].reverse()).source,input.source,'source identity ignores provider ordering and display text')
  }finally{journal.close();await rm(directory,{recursive:true,force:true})}
})
