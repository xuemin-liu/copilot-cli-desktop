import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowFollowups, type FollowupHost } from './workflow-followups.js'
import { WorkflowDeliveries } from './workflow-deliveries.js'
import { WorkflowStore } from './workflow-store.js'
import {DatabaseSync} from 'node:sqlite'
const head='a'.repeat(40),base='b'.repeat(40)
async function fixture(run:(h:Awaited<ReturnType<typeof setup>>)=>Promise<void>,repository='owner/repo'):Promise<void> {
  const h=await setup(repository)
  try{await run(h)}finally{h.controller.close();h.journal.close();h.tasks.close();await rm(h.dir,{recursive:true,force:true})}
}
async function setup(repository='owner/repo') {
  const dir=await mkdtemp(join(tmpdir(),'workflow-followups-'))
  const tasks=new WorkflowStore(join(dir,'tasks.sqlite'))
  const task=tasks.submitted('session','project','Fix the existing checkout bug')
  const journal=new WorkflowDeliveries(join(dir,'deliveries.sqlite'))
  let now=Date.parse('2026-11-02T12:00:00Z'),open=true,merged=false,completions=0,interrupts=0,allowed=true,requests=0
  const comments:object[]=[]
  const injected:string[]=[]
  let block:(()=>Promise<void>)|null=null
  let controller:WorkflowFollowups
  const host:FollowupHost={journal,task:id=>tasks.list().find(t=>t.id===id)??null,
    permissionKey:()=>allowed?'a'.repeat(64):null,verifyRepository:async()=>{},now:()=>now,changed:()=>{},
    interrupt:()=>{interrupts++},
    complete:(task,snapshot,grant)=>{tasks.mergeCompleted(task.id,grant.repository,grant.number,snapshot.head,snapshot.base);completions++},
    api:async path=>{
      requests++
      if(path===`repos/${repository}`)return {full_name:repository}
      if(path==='users/reviewer')return {id:7,login:'reviewer'}
      if(path===`repos/${repository}/pulls/1`){
        if(block){const wait=block;block=null;await wait()}
        return {state:open?'open':'closed',merged,head:{sha:head,ref:'feature',repo:{full_name:repository}},base:{sha:base}}
      }
      if(path.endsWith('/check-runs?per_page=100'))return [{check_runs:[]}]
      if(path===`repos/${repository}/pulls/1/comments?per_page=100`)return [comments]
      return [[]]
    },
    send:async(delivery,grant)=>{
      if(!journal.begin(delivery.id,()=>controller.authorized(grant)))return 'busy'
      injected.push(delivery.id)
      return 'sent'
    },
  }
  controller=new WorkflowFollowups(join(dir,'followups.sqlite'),host)
  return {dir,tasks,task,journal,controller,host,injected,interrupts:()=>interrupts,
    advance:(milliseconds=120001)=>{now+=milliseconds},requests:()=>requests,closePull:()=>{open=false},mergePull:()=>{open=false;merged=true},completions:()=>completions,revoke:()=>{allowed=false},
    blockNext:(wait:()=>Promise<void>)=>{block=wait},
    removeComment:(id:number)=>{const index=comments.findIndex(comment=>(comment as {id:number}).id===id);if(index>=0)comments.splice(index,1)},
    editComment:(id:number,body:string)=>{const comment=comments.find(comment=>(comment as {id:number}).id===id) as Record<string,unknown>;comment.body=body;comment.updated_at=new Date(now+1).toISOString()},
    comment:(id:number,actor=7,commit=head)=>comments.push({id,user:{id:actor},body:`Feedback ${id}`,updated_at:new Date(now+1).toISOString(),commit_id:commit}),
  }
}
test('a repository owned by batch can receive ordinary feedback in a batch',async()=>fixture(async h=>{
  await h.controller.enroll(h.task.id,'https://github.com/batch/repo/pull/1',['reviewer'],false)
  h.comment(1);await h.controller.tick()
  assert.equal(h.injected.length,1)
  const delivery=h.journal.list()[0]!
  assert.equal(delivery.state,'submitted')
  assert.match(delivery.batch!.members[0]!.source,/^github\/batch\/repo\/pull\//)
},'batch/repo'))

test('enrollment baselines old feedback and only allowed new versions enter the durable queue',async()=>fixture(async h=>{
  h.comment(1)
  const grant=await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false)
  await h.controller.tick()
  assert.equal(h.journal.list().length,0)
  h.advance();h.comment(2,999);h.comment(3,7,'c'.repeat(40));h.comment(4)
  await h.controller.tick()
  assert.equal(h.journal.list().length,1)
  assert.equal(h.injected.length,1)
  assert.equal(h.journal.list()[0]!.state,'submitted')
  await h.controller.tick()
  assert.equal(h.injected.length,1)
  assert.equal(h.controller.grant(grant.id)?.total,1)
}))
test('per-head limits bound work and an unresolved submission blocks another event for the session',async()=>fixture(async h=>{
  const grant=await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false)
  h.advance();for(let id=1;id<=31;id++)h.comment(id)
  await h.controller.tick()
  assert.equal(h.journal.list().length,3)
  assert.equal(h.injected.length,1)
  assert.equal(h.controller.grant(grant.id)?.health,'limit')
  h.journal.answered(h.injected[0]!)
  await h.controller.tick()
  assert.equal(h.injected.length,2)
  h.controller.pause(grant.id)
  assert.equal(h.controller.grant(grant.id)?.enabled,false)
  assert.equal(h.interrupts(),1)
}))
test('pause during a source read prevents new authorization or delivery',async()=>fixture(async h=>{
  const grant=await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false)
  h.comment(1)
  let enter!:()=>void,release!:()=>void
  const entered=new Promise<void>(resolve=>{enter=resolve}),wait=new Promise<void>(resolve=>{release=resolve})
  h.blockNext(async()=>{enter();await wait})
  const tick=h.controller.tick()
  await entered;h.controller.pause(grant.id);release();await tick
  assert.equal(h.journal.list().length,0)
  assert.equal(h.injected.length,0)
}))
test('current permission and closed-task checks survive queued work',async()=>fixture(async h=>{
  const grant=await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false)
  h.comment(1);h.revoke();await h.controller.tick()
  assert.equal(h.injected.length,0)
  h.tasks.finish(h.task.id,'completed');h.advance();await h.controller.tick()
  assert.equal(h.controller.grant(grant.id)?.enabled,false)
}))
test('an edited/deleted queued source is never dispatched from an old observation',async()=>fixture(async h=>{
  await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false)
  h.host.ready=()=>false
  h.comment(1);await h.controller.tick()
  assert.equal(h.journal.list()[0]?.state,'queued')
  const old=h.host.api
  h.host.api=async(path,paged)=>path==='repos/owner/repo/pulls/1/comments?per_page=100'?[[]]:old(path,paged)
  h.host.ready=()=>true
  await h.controller.tick()
  assert.equal(h.injected.length,0)
  assert.equal(h.journal.list()[0]?.state,'cancelled')
}))
test('a retired grant cannot replay old work after re-enrollment; unresolved evidence survives retention',async()=>fixture(async h=>{
  const first=await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false)
  h.comment(1);await h.controller.tick()
  h.journal.uncertain(h.injected[0]!)
  h.controller.pause(first.id)
  assert.equal(h.journal.retireScope(first.id),false)
  h.journal.discard(h.injected[0]!)
  assert.equal(h.journal.retireScope(first.id),true)
  const next=await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false)
  assert.notEqual(next.id,first.id)
  assert.equal(h.controller.grant(first.id),null)
  await h.controller.tick()
  assert.equal(h.injected.length,1)
}))
test('shutdown during an awaited source read cannot send or touch a closed database',async()=>fixture(async h=>{
  await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false)
  h.comment(1)
  let enter!:()=>void,release!:()=>void
  const entered=new Promise<void>(r=>enter=r),wait=new Promise<void>(r=>release=r)
  h.blockNext(async()=>{enter();await wait})
  const tick=h.controller.tick();await entered;h.controller.stop();release();await tick
  assert.equal(h.injected.length,0)
}))
test('a changed permission fingerprint revokes enrollment without consuming intake budgets',async()=>fixture(async h=>{
  const grant=await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false)
  h.host.permissionKey=()=> 'b'.repeat(64)
  h.advance();for(let id=1;id<=5;id++)h.comment(id)
  await h.controller.tick();h.advance();await h.controller.tick()
  assert.equal(h.journal.list().length,0)
  assert.equal(h.controller.grant(grant.id)?.total,0)
  assert.equal(h.controller.grant(grant.id)?.health,'scope-changed')
  assert.equal(h.controller.grant(grant.id)?.enabled,false)
}))
test('project/global holds cancel pending work and resume baselines feedback collected during the pause',async()=>fixture(async h=>{
  await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false)
  h.host.ready=()=>false;h.comment(1);await h.controller.tick()
  h.controller.hold('project');assert.equal(h.journal.list()[0]?.state,'cancelled')
  h.comment(2);await h.controller.rebaseline('project')
  h.host.ready=()=>true;h.advance();await h.controller.tick()
  assert.equal(h.injected.length,0)
  h.comment(3);h.advance();await h.controller.tick();assert.equal(h.injected.length,1)
}))
test('busy follow-up attempts coalesce observations and back off without multiplying source reads',async()=>fixture(async h=>{
  await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false)
  let attempts=0;h.host.send=async()=>{attempts++;return 'busy'}
  for(let id=1;id<=3;id++)h.comment(id)
  const before=h.requests();await h.controller.tick()
  assert.equal(h.requests()-before,14,'one intake and one fresh dispatch observation, shared across the queue')
  assert.equal(attempts,1)
  const after=h.requests();await h.controller.tick();assert.equal(h.requests(),after)
  h.advance(10001);await h.controller.tick();assert.equal(h.requests()-after,7)
  const next=h.requests();h.advance(10001);await h.controller.tick();assert.equal(h.requests(),next,'second busy attempt backs off for twenty seconds')
}))
test('an unresolved journal receipt blocks further refreshes for its destination',async()=>fixture(async h=>{
  await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false)
  for(let id=1;id<=3;id++)h.comment(id)
  await h.controller.tick();const before=h.requests()
  h.advance(10001);await h.controller.tick();h.advance(10001);await h.controller.tick()
  assert.equal(h.requests(),before);assert.equal(h.injected.length,1)
}))


test('project defaults verify identities, persist without enrollment, and cannot be restored by an older save',async()=>fixture(async h=>{
  const value=await h.controller.saveDefault('project','owner/repo',['reviewer'],true,true)
  assert.equal(value.reviewers[0]?.id,7)
  assert.equal(h.controller.list().length,0);assert.equal(h.journal.list().length,0);assert.equal(h.injected.length,0)
  const reader=new WorkflowFollowups(join(h.dir,'followups.sqlite'),h.host)
  try{assert.equal(reader.defaults()[0]?.revision,value.revision)}finally{reader.close()}
  const original=h.host.api;let release!:()=>void,entered!:()=>void
  const waiting=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
  h.host.api=async(path,paged)=>{if(path==='repos/owner/repo'){entered();await waiting}return original(path,paged)}
  const save=h.controller.saveDefault('project','owner/repo',['reviewer'],false,false)
  await started;h.controller.removeDefault('project');release()
  await assert.rejects(save,/changed/)
  assert.equal(h.controller.defaults().length,0)
}))

for(const enabled of [false,true])test(`verified merge completion is explicitly opted in: ${enabled}`,async()=>fixture(async h=>{
  const grant=await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false,enabled)
  h.advance();h.mergePull();await h.controller.tick()
  assert.equal(h.completions(),enabled?1:0)
  if(enabled)assert.deepEqual(h.tasks.list().find(task=>task.id===h.task.id)?.completion,{kind:'pr-merge',repository:'owner/repo',number:1,head,base,at:h.tasks.list().find(task=>task.id===h.task.id)!.completion!.at})
  assert.equal(h.tasks.list().find(task=>task.id===h.task.id)?.outcome,enabled?'completed':'working')
  assert.equal(h.controller.grant(grant.id)?.enabled,false)
  assert.equal(h.injected.length,0)
}))

test('pause during a merge read revokes completion',async()=>fixture(async h=>{
  const first=await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false,true)
  let release!:()=>void,entered!:()=>void
  const waiting=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{entered=resolve})
  h.advance();h.mergePull();h.blockNext(async()=>{entered();await waiting})
  const tick=h.controller.tick();await started;h.controller.pause(first.id);release();await tick
  assert.equal(h.completions(),0)
}))

test('an opted-in PR closed without merging retains its task outcome',async()=>fixture(async h=>{
  await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false,true)
  h.closePull();h.advance();await h.controller.tick()
  assert.equal(h.completions(),0);assert.equal(h.tasks.active(h.task.sessionId)?.outcome,'working')
}))

test('merge completion survives a paused resume baseline but waits for authorization to return',async()=>fixture(async h=>{
  const grant=await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false,true)
  const permission=h.host.permissionKey;let paused=true;h.host.permissionKey=task=>paused?null:permission(task)
  h.mergePull();h.advance();await h.controller.rebaseline('project')
  assert.equal(h.completions(),0);assert.equal(h.controller.grant(grant.id)?.enabled,true)
  paused=false;await h.controller.tick()
  assert.equal(h.completions(),1)
}))

test('pause during a queued merge refresh preserves the opted-in completion condition',async()=>fixture(async h=>{
  const grant=await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false,true)
  h.host.send=async()=> 'busy'
  h.comment(1);await h.controller.tick()
  assert.equal(h.journal.list()[0]?.state,'queued')
  const permission=h.host.permissionKey;let paused=false
  h.host.permissionKey=task=>paused?null:permission(task)
  let entered!:()=>void,release!:()=>void
  const started=new Promise<void>(resolve=>{entered=resolve}),waiting=new Promise<void>(resolve=>{release=resolve})
  h.advance(10001);h.mergePull();h.blockNext(async()=>{entered();await waiting})
  const tick=h.controller.tick();await started;paused=true;h.controller.hold('project');release();await tick
  assert.equal(h.completions(),0)
  assert.equal(h.journal.list()[0]?.state,'cancelled')
  assert.equal(h.controller.grant(grant.id)?.enabled,true,'temporary pause keeps the merge condition')
  assert.equal(h.controller.grant(grant.id)?.health,'needs-person')
  await h.controller.rebaseline('project');paused=false;await h.controller.tick()
  assert.equal(h.completions(),1,'completion recovers without re-enrolling the closed PR')
  assert.equal(h.controller.grant(grant.id)?.enabled,false)
  assert.deepEqual(h.injected,[])
}))

test('exhausted continuation budgets cannot prevent opted-in merge completion',async()=>fixture(async h=>{
  const grant=await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false,true)
  const writer=new DatabaseSync(join(h.dir,'followups.sqlite'))
  try{writer.prepare('UPDATE followups SET value=? WHERE id=?').run(JSON.stringify({...grant,total:10,headCounts:{[head]:3,['c'.repeat(40)]:3,['d'.repeat(40)]:3,['e'.repeat(40)]:1},health:'limit'}),grant.id)}finally{writer.close()}
  h.mergePull();h.advance();await h.controller.tick()
  assert.equal(h.completions(),1);assert.equal(h.injected.length,0)
}))

test('revoked permissions during merge observation cannot complete a task',async()=>fixture(async h=>{
  await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false,true)
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve}),wait=new Promise<void>(resolve=>{release=resolve})
  h.mergePull();h.advance();h.blockNext(async()=>{entered();await wait})
  const tick=h.controller.tick();await started;h.revoke();release();await tick
  assert.equal(h.completions(),0);assert.equal(h.tasks.active(h.task.sessionId)?.outcome,'working')
}))

test('related feedback shares one bounded continuation with durable source membership',async()=>fixture(async h=>{
  const grant=await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false)
  for(let n=1;n<=7;n++)h.comment(n)
  await h.controller.tick()
  const receipt=h.journal.list()[0]!
  assert.equal(h.journal.list().length,1);assert.equal(receipt.batch?.members.length,7)
  assert.equal(h.injected.length,1);assert.equal(h.controller.grant(grant.id)?.total,1)
  for(let n=1;n<=7;n++)assert.match(receipt.text,new RegExp(`Feedback ${n}`))
  assert.ok(receipt.text.length<=12000)
}))

test('deleting one queued member retains and delivers the remaining current feedback',async()=>fixture(async h=>{
  const grant=await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false)
  h.host.ready=()=>false;h.comment(1);h.comment(2);await h.controller.tick()
  const old=h.journal.list()[0]!
  h.removeComment(1);h.host.ready=()=>true;h.advance(10001);await h.controller.tick()
  const queued=h.journal.list().filter(item=>item.state==='queued')
  assert.equal(h.journal.get(old.id)?.state,'cancelled');assert.equal(queued.length,1)
  assert.equal(queued[0]?.batch?.members.length,1);assert.match(queued[0]!.batch!.members[0]!.source,/\/2$/)
  assert.equal(queued[0]?.batch?.reservation,old.batch?.reservation)
  assert.equal(h.controller.grant(grant.id)?.total,1)
  await h.controller.tick();assert.equal(h.injected.length,1)
  assert.doesNotMatch(h.journal.get(h.injected[0]!)!.text,/Feedback 1/)
}))

test('edits already reserved in another batch never duplicate its feedback or lose unchanged members',async()=>fixture(async h=>{
  await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false)
  h.host.ready=()=>false;h.comment(1);h.comment(2);await h.controller.tick()
  h.advance();h.editComment(1,'Updated feedback');await h.controller.tick()
  h.host.ready=()=>true;await h.controller.tick()
  assert.equal(h.injected.length,1);assert.match(h.journal.get(h.injected[0]!)!.text,/Updated feedback/)
  h.journal.answered(h.injected[0]!);await h.controller.tick()
  assert.equal(h.injected.length,2)
  const members=h.injected.flatMap(id=>h.journal.get(id)!.batch!.members)
  assert.equal(members.length,2);assert.equal(new Set(members.map(member=>member.source+' '+member.version)).size,2)
  assert.ok(h.injected.some(id=>h.journal.get(id)!.text.includes('Feedback 2')))
}))

test('durable reservations recover deduplication and budgets when a grant write lagged the journal',async()=>fixture(async h=>{
  const grant=await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false)
  h.host.ready=()=>false
  for(let n=1;n<=4;n++){
    const current=h.controller.grant(grant.id)!,writer=new DatabaseSync(join(h.dir,'followups.sqlite'))
    try{writer.prepare('UPDATE followups SET value=? WHERE id=?').run(JSON.stringify({...current,seen:{},total:0,headCounts:{}}),grant.id)}finally{writer.close()}
    h.advance();h.comment(n);await h.controller.tick()
  }
  const rows=h.journal.list()
  assert.equal(rows.length,3);assert.equal(h.controller.grant(grant.id)?.total,3)
  assert.equal(h.controller.grant(grant.id)?.headCounts[head],3)
  const members=rows.flatMap(row=>row.batch!.members)
  assert.equal(members.length,3);assert.equal(new Set(members.map(member=>member.source)).size,3)
}))

test('inconsistent duplicate source versions stop collection without partial batches',async()=>fixture(async h=>{
  const grant=await h.controller.enroll(h.task.id,'https://github.com/owner/repo/pull/1',['reviewer'],false)
  const original=h.host.api
  h.host.api=async(path,paged)=>path==='repos/owner/repo/pulls/1/comments?per_page=100'?[[{id:1,user:{id:7},body:'Version A',updated_at:'2026-11-02T12:00:01Z'},{id:1,user:{id:7},body:'Version B',updated_at:'2026-11-02T12:00:01Z'}]]:original(path,paged)
  h.advance();await h.controller.tick()
  assert.equal(h.journal.list().length,0);assert.equal(h.controller.grant(grant.id)?.health,'source-unavailable');assert.equal(h.controller.failed,false)
}))
