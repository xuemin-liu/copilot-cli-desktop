import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {WorkflowDeliveries} from './workflow-deliveries.js'
import {journalMeetingDelivery,settleClosedMeeting} from './workflow-meeting-journal.js'
import {MEETING_TURN_RETRIES,MEETING_TURN_RETRY_MS,MeetingHub,type MeetingDelivery} from './meeting.js'
import {MeetingOutbox} from './meeting-delivery.js'

const SESSION:Record<string,string>={host:'11111111-1111-4111-8111-111111111111',reviewer:'22222222-2222-4222-8222-222222222222'}
const TAB_OF_SESSION:Record<string,string>={[SESSION.host!]:'host',[SESSION.reviewer!]:'reviewer'}

/** One run of the app: a hub and an outbox over the journal on disk, with the same drop rule as main's. Nothing types until `pump`. */
function appRun(journal:WorkflowDeliveries,saved?:unknown){
  let now=1_000
  let timers:Array<{at:number;run:()=>void}>=[]
  const typed:Array<{tabId:string}&MeetingDelivery>=[],files=new Map<string,string>()
  const advance=(ms:number)=>{
    now+=ms
    const due=timers.filter(timer=>timer.at<=now)
    timers=timers.filter(timer=>timer.at>now)
    for(const timer of due)timer.run()
  }
  const hub:MeetingHub=new MeetingHub(()=>'C:\\meetings',{
    deliver:(tabId,delivery)=>outbox.enqueue(tabId,delivery),
    cancel:(meetingId,tabId)=>outbox.cancel(meetingId,tabId),
    write:(_meetingId,path,text)=>{files.set(path,text)},
    changed:()=>{},notify:()=>{},
    sessionIdOf:tabId=>SESSION[tabId]??null,
  },()=>({maxRounds:6,roundTimeoutMinutes:10}),{now:()=>now,set:(run,ms)=>{const timer={at:now+ms,run};timers.push(timer);return()=>{timers=timers.filter(other=>other!==timer)}}},()=>'K7QF')
  const outbox:MeetingOutbox=new MeetingOutbox({
    settled:(tabId,delivery)=>{
      if(hub.superseded(tabId,delivery))return true
      if(delivery.kind==='add-dir')return false
      const item=journalMeetingDelivery(journal,SESSION[tabId]!,delivery)
      return item!==null&&['answered','cancelled'].includes(item.state)
    },
    sendTask:(tabId,_text,delivery)=>{
      const item=journalMeetingDelivery(journal,SESSION[tabId]!,delivery)
      if(item?.state!=='queued')return {result:'busy',message:'Inspect the meeting handoff in Handoffs.'}
      journal.begin(item.id,()=>true);journal.submitted(item.id)
      typed.push({tabId,...delivery})
      return {result:'sent'}
    },
    sendCommand:()=>true,sent:()=>{},refused:()=>{},now:()=>now,
  })
  if(saved)hub.restore(saved as never,'',sessionId=>({tabId:TAB_OF_SESSION[sessionId]!,title:'restored',folder:null}))
  /** Past the settling time of a folder command, however many went in. */
  const pump=()=>{for(let i=0;i<4;i++){outbox.pump();advance(2_000)}}
  /** A delivery's turn is over and its receipt settled, as main does right after it told the hub. */
  const answered=(tabId:string,delivery:MeetingDelivery)=>{const item=journalMeetingDelivery(journal,SESSION[tabId]!,delivery)!;journal.answered(item.id)}
  const saved_=()=>JSON.parse(files.get(join('C:\\meetings','K7QF','meeting.json'))!)
  return {hub,outbox,typed,advance,pump,answered,saved:saved_}
}

/** Up to the point the host's turn with the round 1 replies is running. */
function untilHostHasReplies(run:ReturnType<typeof appRun>):MeetingDelivery{
  run.hub.start({tabId:'host',title:'host',folder:'D:\\api'},{topic:'plan',post:'plan',changes:null})
  run.hub.join({tabId:'reviewer',title:'reviewer',folder:'D:\\api'},'K7QF')
  run.pump()
  const post=run.outbox.turnEnded('reviewer')!
  run.hub.turnCompleted('reviewer',post,'r1')
  run.answered('reviewer',post)
  run.pump()
  return run.outbox.turnEnded('host')!
}

test('a restart while a failed turn waits to go in again still types what the host owes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'meeting-retry-')),journal=new WorkflowDeliveries(join(dir,'journal.sqlite'))
  try{
    const before=appRun(journal),digest=untilHostHasReplies(before)
    assert.equal(digest.kind,'digest')
    before.hub.turnFailed('host',digest,'400')
    before.answered('host',digest)

    const after=appRun(journal,before.saved())
    after.pump()
    const typed=after.typed.filter(item=>item.tabId==='host')
    assert.equal(typed.length,1,'the settled receipt must not swallow what is owed')
    assert.equal(typed[0]!.text,digest.text)
    assert.notEqual(typed[0]!.id,digest.id)
    assert.equal(after.hub.views()[0]!.stage,'host')
  }finally{journal.close();await rm(dir,{recursive:true,force:true})}
})

test('a restart after the person took over a turn still types what the session owes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'meeting-retry-')),journal=new WorkflowDeliveries(join(dir,'journal.sqlite'))
  try{
    const before=appRun(journal),digest=untilHostHasReplies(before)
    assert.ok(before.hub.takenOver('host',digest))
    before.answered('host',digest)

    const after=appRun(journal,before.saved())
    after.pump()
    assert.deepEqual(after.typed.filter(item=>item.tabId==='host').map(item=>item.text),[digest.text])
  }finally{journal.close();await rm(dir,{recursive:true,force:true})}
})

test('a restart after a reviewer ran out of tries asks it once more',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'meeting-retry-')),journal=new WorkflowDeliveries(join(dir,'journal.sqlite'))
  try{
    const before=appRun(journal)
    before.hub.start({tabId:'host',title:'host',folder:'D:\\api'},{topic:'plan',post:'plan',changes:null})
    before.hub.join({tabId:'reviewer',title:'reviewer',folder:'D:\\api'},'K7QF')
    before.pump()
    for(let tries=0;tries<=MEETING_TURN_RETRIES;tries++){
      const post=before.outbox.turnEnded('reviewer')!
      before.hub.turnFailed('reviewer',post,'400')
      before.answered('reviewer',post)
      before.advance(MEETING_TURN_RETRY_MS)
      before.pump()
    }
    assert.equal(before.typed.filter(item=>item.tabId==='reviewer').length,1+MEETING_TURN_RETRIES)

    const after=appRun(journal,before.saved())
    after.pump()
    assert.equal(after.typed.filter(item=>item.tabId==='reviewer').length,1)
  }finally{journal.close();await rm(dir,{recursive:true,force:true})}
})

test('a queued retry whose host moved the round on stays dropped after a restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'meeting-retry-')),journal=new WorkflowDeliveries(join(dir,'journal.sqlite'))
  try{
    const before=appRun(journal),digest=untilHostHasReplies(before)
    before.hub.turnFailed('host',digest,'400')
    before.answered('host',digest)
    before.advance(MEETING_TURN_RETRY_MS)
    before.hub.post('host','round','plan v2',null)
    const saved=before.saved()
    const left=saved.outstanding.find((entry:{sessionId:string})=>entry.sessionId===SESSION.host).delivery
    assert.equal(left.round,1);assert.equal(left.again,true)

    const after=appRun(journal,saved)
    after.pump()
    assert.deepEqual(after.typed.filter(item=>item.tabId==='host'),[],'the old digest is not typed')
    assert.equal(after.typed.find(item=>item.tabId==='reviewer')?.round,2)
    const round2=after.outbox.turnEnded('reviewer')!
    after.hub.turnCompleted('reviewer',round2,'r2')
    after.pump()
    assert.deepEqual(after.typed.filter(item=>item.tabId==='host').map(item=>[item.kind,item.round]),[['digest',2]],'the next digest goes in')
  }finally{journal.close();await rm(dir,{recursive:true,force:true})}
})

for(const [name,repeat] of [
  ['its model failed',(run:ReturnType<typeof appRun>,delivery:MeetingDelivery)=>run.hub.turnFailed('host',delivery,'400')],
  ['the person took over its turn',(run:ReturnType<typeof appRun>,delivery:MeetingDelivery)=>run.hub.askAgain('host',run.hub.takenOver('host',delivery)!)],
] as const)test(`a legacy message sent again by the person repeats as an ordinary one after ${name}`,async()=>{
  const dir=await mkdtemp(join(tmpdir(),'meeting-retry-')),journal=new WorkflowDeliveries(join(dir,'journal.sqlite'))
  try{
    const before=appRun(journal),digest=untilHostHasReplies(before)
    before.answered('host',digest)
    const saved=before.saved()
    delete saved.outstanding.find((entry:{sessionId:string})=>entry.sessionId===SESSION.host).delivery.id

    const after=appRun(journal,saved)
    after.pump()
    assert.equal(after.typed.length,0,'a meeting file from before the journal cannot prove it was not typed')
    const legacy=journal.list().find(item=>item.state==='uncertain')!
    journal.retry(legacy.id)
    after.pump()
    assert.equal(after.typed.length,1,'the person chose Send again')
    assert.equal(after.typed[0]!.recovered,true)

    const turn=after.outbox.turnEnded('host')!
    repeat(after,turn)
    after.answered('host',turn)
    after.advance(MEETING_TURN_RETRY_MS)
    after.pump()
    assert.equal(after.typed.length,2,'it goes in without another decision')
    assert.equal(after.typed[1]!.recovered,undefined)
    assert.equal(journalMeetingDelivery(journal,SESSION.host!,after.typed[1]!)?.state,'submitted')
  }finally{journal.close();await rm(dir,{recursive:true,force:true})}
})

test('meeting identity survives restart and never resends an ambiguous turn without a person',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'meeting-journal-')),path=join(dir,'journal.sqlite')
  let journal=new WorkflowDeliveries(path)
  const delivery:MeetingDelivery={id:randomUUID(),meetingId:'K7QF',round:1,kind:'post',text:'Review token=fixture-secret'}
  try{
    const item=journalMeetingDelivery(journal,'session',delivery)!
    assert.equal(item.state,'queued');assert.ok(!item.text.includes('fixture-secret'));assert.ok(!item.text.includes('Review token='))
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
test('what a closed meeting left uncertain stops blocking its session, and other meetings keep theirs',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'meeting-journal-')),path=join(dir,'journal.sqlite')
  try{
    let journal=new WorkflowDeliveries(path)
    const session=randomUUID(),other=randomUUID()
    const post=(meetingId:string):MeetingDelivery=>({meetingId,round:1,kind:'post',text:'Plan',id:randomUUID()})
    const closed=journalMeetingDelivery(journal,session,post('K7QF'))!
    journal.begin(closed.id,()=>true);journal.submitted(closed.id)
    const open=journalMeetingDelivery(journal,other,post('M2NB'))!
    journal.begin(open.id,()=>true);journal.submitted(open.id)
    // The app restarts during both turns: everything in flight becomes uncertain, and blocks its session.
    journal.close();journal=new WorkflowDeliveries(path)
    assert.equal(journal.get(closed.id)?.state,'uncertain')
    const next=journalMeetingDelivery(journal,session,post('P3RT'))!
    assert.equal(journal.begin(next.id,()=>true),null,'the leftover blocks the next meeting')

    settleClosedMeeting(journal,'meeting/K7QF')
    assert.equal(journal.get(closed.id),null,'nothing is left of the closed meeting')
    assert.equal(journal.begin(next.id,()=>true)?.state,'submitting','the next meeting gets through')
    assert.equal(journal.get(open.id)?.state,'uncertain','an open meeting keeps its evidence for the person')
    journal.close()
  }finally{await rm(dir,{recursive:true,force:true})}
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
