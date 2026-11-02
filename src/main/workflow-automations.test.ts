import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {WorkflowAutomations,AutomationLaunchRefused,type AutomationHost} from './workflow-automations.js'
import {readAutomationEvents} from './workflow-automation-source.js'
const head='a'.repeat(40)
async function fixture(action:(h:Awaited<ReturnType<typeof setup>>)=>Promise<void>):Promise<void>{const h=await setup();try{await action(h)}finally{h.close();await rm(h.dir,{recursive:true,force:true})}}
async function setup(){
  const dir=await mkdtemp(join(tmpdir(),'workflow-rules-')),path=join(dir,'rules.sqlite')
  let now=Date.parse('2026-11-02T12:00:00Z'),launches=0,interrupts=0,scope='a'.repeat(64),reads=0
  const checks:object[]=[],assignments:object[]=[]
  let wait:(()=>Promise<void>)|null=null
  const host:AutomationHost={changed:()=>{},interrupt:()=>{interrupts++},ready:()=>true,scopeKey:()=>scope,now:()=>now,
    api:async(path)=>{
      reads++
      if(wait){const w=wait;wait=null;await w()}
      if(path==='user')return {id:8,login:'viewer'}
      if(path==='users/assigner')return {id:7,login:'assigner'}
      if(path==='apps/actions')return {id:9,slug:'actions'}
      if(path==='repos/owner/repo')return {default_branch:'main'}
      if(path==='repos/owner/repo/commits/main')return {sha:head}
      if(path.endsWith('/check-runs?per_page=100'))return [{check_runs:checks}]
      if(path.endsWith('/issues/events?per_page=100'))return [assignments]
      if(path==='repos/owner/repo/issues?assignee=viewer&state=open&per_page=100')return [[{number:1}]]
      if(path==='repos/owner/repo/issues/1/events?per_page=100')return [assignments]
      if(path==='repos/owner/repo/issues/1')return {state:'open',title:'Bug token=fixture-secret',body:'Please investigate',assignees:[{id:8}]}
      throw new Error('Unexpected fixture path')
    },launch:async(_rule,_event,authorized)=>{assert.equal(authorized(),true);launches++;return {sessionId:'session',taskId:'task'}},
  }
  let store=new WorkflowAutomations(path,host)
  return {dir,path,host,get store(){return store},close:()=>store.close(),reopen:()=>{store.close();store=new WorkflowAutomations(path,host)},
    advance:()=>{now+=120001},launches:()=>launches,interrupts:()=>interrupts,reads:()=>reads,revoke:()=>{scope='b'.repeat(64)},
    block:(fn:()=>Promise<void>)=>{wait=fn},
    fail:(id:number,actor=9)=>{checks.push({id,name:`unit-${id} token=fixture-secret`,app:{id:actor},status:'completed',conclusion:'failure',completed_at:new Date(now+1).toISOString()})},
    assign:()=>{assignments.push({id:1,event:'assigned',actor:{id:7},assignee:{id:8},issue:{number:1},created_at:new Date(now+1).toISOString()})},
  }
}
test('Preview has no launch effects, redacts persistence, and activation never executes its backlog',async()=>fixture(async h=>{
  await h.store.configure('project','owner/repo','default-ci',['actions'])
  const id=h.store.rules()[0]!.id
  h.advance();h.fail(1);await h.store.tick()
  assert.equal(h.launches(),0);assert.equal(h.store.previews().length,1)
  assert.ok(!JSON.stringify(h.store.previews()).includes('fixture-secret'))
  await h.store.setMode(id,'automatic');await h.store.tick()
  assert.equal(h.launches(),0)
  h.advance();h.fail(2);await h.store.tick();await h.store.tick()
  assert.equal(h.launches(),1)
  assert.equal(h.store.previews().filter(p=>p.state==='started').length,1)
  assert.equal((await readFile(h.path)).includes(Buffer.from('fixture-secret')),false)
}))
test('Off collects nothing, assignment actors are allowlisted, and explicit preview start revalidates',async()=>fixture(async h=>{
  await h.store.configure('project','owner/repo','assigned-issue',['assigner'])
  const id=h.store.rules()[0]!.id
  h.advance();h.assign();await h.store.tick()
  assert.equal(h.store.previews().length,1);assert.equal(h.launches(),0)
  await h.store.startPreview(h.store.previews()[0]!.id);assert.equal(h.launches(),1)
  await h.store.setMode(id,'off');const reads=h.reads();h.advance();await h.store.tick();assert.equal(h.reads(),reads)
}))
test('two matching automatic rules reserve only one owner across restart',async()=>fixture(async h=>{
  for(let i=0;i<2;i++){await h.store.configure('project','owner/repo','default-ci',['actions']);await h.store.setMode(h.store.rules().at(-1)!.id,'automatic')}
  h.advance();h.fail(1);await h.store.tick()
  assert.equal(h.launches(),1);assert.equal(h.store.previews().filter(p=>p.state==='overlap').length,1)
  h.reopen();h.advance();await h.store.tick();assert.equal(h.launches(),1)
}))
test('global/project pause persists and resume baselines accumulated events',async()=>fixture(async h=>{
  await h.store.configure('project','owner/repo','default-ci',['actions']);await h.store.setMode(h.store.rules()[0]!.id,'automatic')
  await h.store.setPaused(true);assert.equal(h.interrupts(),1);h.reopen();assert.equal(h.store.paused('project'),true)
  h.advance();h.fail(1);await h.store.tick();assert.equal(h.store.previews().length,0)
  await h.store.setPaused(false);await h.store.tick();assert.equal(h.launches(),0)
  await h.store.setPaused(true,'project');assert.equal(h.store.paused('project'),true);assert.equal(h.store.paused(),false)
}))
test('pause during refreshed evidence prevents a launch; scope changes and unknown actors cannot dispatch',async()=>fixture(async h=>{
  await h.store.configure('project','owner/repo','default-ci',['actions']);await h.store.setMode(h.store.rules()[0]!.id,'automatic')
  h.fail(1,999);h.advance();await h.store.tick();assert.equal(h.store.previews().length,0)
  h.fail(2);h.advance()
  let entered!:()=>void,release!:()=>void
  const enter=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r)
  h.block(async()=>{entered();await wait});const tick=h.store.tick();await enter;await h.store.setPaused(true);release();await tick
  assert.equal(h.launches(),0)
  await h.store.setPaused(false);h.revoke();h.advance();h.fail(3);await h.store.tick();assert.equal(h.launches(),0)
}))
test('three daily starts bound automatic work and an ambiguous launch never retries',async()=>fixture(async h=>{
  await h.store.configure('project','owner/repo','default-ci',['actions']);await h.store.setMode(h.store.rules()[0]!.id,'automatic')
  h.host.launch=async()=>{throw new Error('crash after creating session')}
  h.advance();h.fail(1);await h.store.tick();assert.equal(h.store.previews()[0]?.state,'uncertain')
  h.reopen();h.advance();await h.store.tick();assert.equal(h.store.previews()[0]?.state,'uncertain')
  h.host.launch=async()=>({sessionId:'session',taskId:'task'})
  for(let i=2;i<=5;i++){h.advance();h.fail(i);await h.store.tick()}
  assert.equal(h.store.rules()[0]?.launches,3)
  assert.ok(h.store.previews().some(p=>p.state==='limit'))
}))
test('assignment source requires current open assignment and default-branch reads are consistent',async()=>fixture(async h=>{
  h.assign();assert.equal((await readAutomationEvents(h.host.api,'owner/repo','assigned-issue')).length,1)
  const api=h.host.api
  h.host.api=async(path,paged)=>path==='repos/owner/repo/issues/1'?{state:'closed',assignees:[{id:8}]}:api(path,paged)
  assert.equal((await readAutomationEvents(h.host.api,'owner/repo','assigned-issue')).length,0)
  let reads=0
  await assert.rejects(readAutomationEvents(async(path,paged)=>path==='repos/owner/repo/commits/main'&&++reads===2?{sha:'b'.repeat(40)}:api(path,paged),'owner/repo','default-ci'),/changed/)
}))
test('resuming invalidates earlier queued previews and a newer pause supersedes an awaited resume',async()=>fixture(async h=>{
  await h.store.configure('project','owner/repo','default-ci',['actions']);const id=h.store.rules()[0]!.id
  h.fail(1);h.advance();await h.store.tick();const preview=h.store.previews()[0]!
  await h.store.setPaused(true);await h.store.setPaused(false)
  await assert.rejects(h.store.startPreview(preview.id),/stale/)
  assert.equal(h.launches(),0)
  await h.store.setPaused(true)
  let entered!:()=>void,release!:()=>void
  const enter=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r)
  h.block(async()=>{entered();await wait})
  const resume=h.store.setPaused(false);void resume.catch(()=>{});await enter;await h.store.setPaused(true);release()
  await assert.rejects(resume,/changed/);assert.equal(h.store.paused(),true)
  await h.store.configure('project','owner/repo','default-ci',['actions'],id)
  assert.equal(h.store.rules()[0]?.mode,'preview')
}))
test('long redacted preview summaries remain decodable after restart',async()=>fixture(async h=>{
  await h.store.configure('project','owner/repo','default-ci',['actions'])
  const api=h.host.api
  h.host.api=async(path,paged)=>path.endsWith('/check-runs?per_page=100')?[{check_runs:[{id:99,name:'x'.repeat(1900)+' token=x '.repeat(20),app:{id:9},status:'completed',conclusion:'failure',completed_at:'2026-11-02T12:10:00Z'}]}]:api(path,paged)
  h.advance();await h.store.tick();h.reopen()
  assert.equal(h.store.previews().length,1)
  assert.ok(h.store.previews()[0]!.summary.length<=2000)
}))
test('assigned-issue rules never download unrelated repository event history',async()=>fixture(async h=>{
  h.assign();const api=h.host.api
  let historyReads=0
  h.host.api=async(path,paged)=>{
    if(path==='repos/owner/repo/issues/events?per_page=100'){historyReads++;return [Array.from({length:1001},(_,id)=>({id:id+10,event:'closed'}))]}
    return api(path,paged)
  }
  const events=await readAutomationEvents(h.host.api,'owner/repo','assigned-issue')
  assert.equal(events.length,1);assert.equal(historyReads,0)
}))
test('a proven pre-creation refusal releases source ownership and budgets for an explicit retry',async()=>fixture(async h=>{
  await h.store.configure('project','owner/repo','default-ci',['actions'])
  h.fail(1);h.advance();await h.store.tick();const preview=h.store.previews()[0]!
  h.host.launch=async()=>{throw new AutomationLaunchRefused('Reconcile the default-branch checkout before retrying')}
  await h.store.startPreview(preview.id)
  assert.equal(h.store.previews()[0]?.state,'preview')
  assert.equal(h.store.rules()[0]?.launches,0);assert.equal(h.store.rules()[0]?.dayLaunches,0)
  h.host.launch=async()=>({sessionId:'session',taskId:'task'})
  await h.store.startPreview(preview.id)
  assert.equal(h.store.previews()[0]?.state,'started');assert.equal(h.store.rules()[0]?.launches,1)
}))
