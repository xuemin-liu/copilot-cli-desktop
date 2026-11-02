import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowFollowups, type FollowupHost } from './workflow-followups.js'
import { WorkflowDeliveries } from './workflow-deliveries.js'
import { WorkflowStore } from './workflow-store.js'
const head='a'.repeat(40),base='b'.repeat(40)
async function fixture(run:(h:Awaited<ReturnType<typeof setup>>)=>Promise<void>):Promise<void> {
  const h=await setup()
  try{await run(h)}finally{h.controller.close();h.journal.close();h.tasks.close();await rm(h.dir,{recursive:true,force:true})}
}
async function setup() {
  const dir=await mkdtemp(join(tmpdir(),'workflow-followups-'))
  const tasks=new WorkflowStore(join(dir,'tasks.sqlite'))
  const task=tasks.submitted('session','project','Fix the existing checkout bug')
  const journal=new WorkflowDeliveries(join(dir,'deliveries.sqlite'))
  let now=Date.parse('2026-11-02T12:00:00Z'),open=true,interrupts=0,allowed=true,requests=0
  const comments:object[]=[]
  const injected:string[]=[]
  let block:(()=>Promise<void>)|null=null
  let controller:WorkflowFollowups
  const host:FollowupHost={journal,task:id=>tasks.list().find(t=>t.id===id)??null,
    permissionKey:()=>allowed?'a'.repeat(64):null,verifyRepository:async()=>{},now:()=>now,changed:()=>{},
    interrupt:()=>{interrupts++},
    api:async path=>{
      requests++
      if(path==='users/reviewer')return {id:7,login:'reviewer'}
      if(path==='repos/owner/repo/pulls/1'){
        if(block){const wait=block;block=null;await wait()}
        return {state:open?'open':'closed',head:{sha:head,ref:'feature',repo:{full_name:'owner/repo'}},base:{sha:base}}
      }
      if(path.endsWith('/check-runs?per_page=100'))return [{check_runs:[]}]
      if(path==='repos/owner/repo/pulls/1/comments?per_page=100')return [comments]
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
    advance:(milliseconds=120001)=>{now+=milliseconds},requests:()=>requests,closePull:()=>{open=false},revoke:()=>{allowed=false},
    blockNext:(wait:()=>Promise<void>)=>{block=wait},
    comment:(id:number,actor=7,commit=head)=>comments.push({id,user:{id:actor},body:`Feedback ${id}`,updated_at:new Date(now+1).toISOString(),commit_id:commit}),
  }
}
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
  h.advance();for(let id=1;id<=5;id++)h.comment(id)
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
