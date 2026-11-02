import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {WorkflowDeliveries} from './workflow-deliveries.js'
import {journalMeetingDelivery} from './workflow-meeting-journal.js'
import type {MeetingDelivery} from './meeting.js'

test('meeting identity survives restart and never resends an ambiguous turn without a person',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'meeting-journal-')),path=join(dir,'journal.sqlite')
  let journal=new WorkflowDeliveries(path)
  const delivery:MeetingDelivery={id:randomUUID(),meetingId:'K7QF',round:1,kind:'post',text:'Review token=fixture-secret'}
  try{
    const item=journalMeetingDelivery(journal,'session',delivery)!
    assert.equal(item.state,'queued');assert.equal(item.text,'Review token=[REDACTED]')
    journal.begin(item.id,()=>true);journal.submitted(item.id);journal.close();journal=new WorkflowDeliveries(path)
    const recovered=journalMeetingDelivery(journal,'session',{...delivery})!
    assert.equal(recovered.id,item.id);assert.equal(recovered.state,'uncertain')
    assert.equal(journal.begin(recovered.id,()=>true),null)
    journal.retry(recovered.id)
    assert.equal(journalMeetingDelivery(journal,'session',delivery)?.state,'queued')
    journal.begin(item.id,()=>true);journal.submitted(item.id);journal.answered(item.id)
    assert.equal(journalMeetingDelivery(journal,'session',delivery)?.state,'answered')
  }finally{journal.close();await rm(dir,{recursive:true,force:true})}
})
test('legacy outstanding prompts require reconciliation and respect another source’s unresolved ownership',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'meeting-legacy-')),journal=new WorkflowDeliveries(join(dir,'journal.sqlite'))
  const legacy:MeetingDelivery={id:randomUUID(),recovered:true,meetingId:'K7QF',round:1,kind:'post',text:'Old outstanding prompt'}
  try{
    const other=journal.enqueue({sessionId:'session',source:'github/1',revision:'r1',scope:'grant',text:'Fix'});journal.begin(other.id,()=>true)
    assert.equal(journalMeetingDelivery(journal,'session',legacy),null)
    assert.equal(journal.list().length,1,'legacy input is not silently queued behind ambiguous ownership')
    journal.uncertain(other.id);journal.discard(other.id)
    let changes=0
    const item=journalMeetingDelivery(journal,'session',legacy,()=>{changes++})!
    assert.equal(item.state,'uncertain')
    assert.equal(changes,1,'legacy reconciliation becomes visible without waiting for CLI output')
    journalMeetingDelivery(journal,'session',legacy,()=>{changes++})
    assert.equal(changes,1,'unchanged queue polls do not send repeated UI updates')
    journal.retry(item.id)
    assert.equal(journalMeetingDelivery(journal,'session',legacy)?.state,'queued','an explicit person decision is preserved')
  }finally{journal.close();await rm(dir,{recursive:true,force:true})}
})
