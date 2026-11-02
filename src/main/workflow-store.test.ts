import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowStore, WorkflowTaskLimitError } from './workflow-store.js'
import { DatabaseSync } from 'node:sqlite'
const session = '11111111-1111-4111-8111-111111111111'

test('structured reports retain a question, artifacts, revision evidence and earlier reports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-details-'))
  const store = new WorkflowStore(join(dir, 'tasks.sqlite'))
  try {
    const task = store.submitted(session, 'project', 'Implement the checkout change')
    store.report(session, {taskId:task.id,assignmentId:task.assignmentId,scopeRevision:1,outcome:'needs-input',
      summary:'Choose a rounding rule',question:'Should token=fixture-question use bankers rounding?',
      artifacts:[{label:'Review token=fixture-label',kind:'url',value:'https://github.com/owner/repo/pull/1?token=fixture-url'}],
      validation:[{name:'unit tests',status:'passed',revision:'abc123'}]})
    store.report(session, {taskId:task.id,assignmentId:task.assignmentId,scopeRevision:1,outcome:'ready',summary:'Ready to review'})
    const current = store.active(session) as unknown as {reports:{question:string;artifacts:{value:string}[];validation:{revision:string}[]}[]}
    assert.equal(current.reports.length,2)
    assert.equal(current.reports[0]?.question,'Should token=[REDACTED] use bankers rounding?')
    assert.doesNotMatch(JSON.stringify(current),/fixture-(question|label|url)/)
    assert.equal(current.reports[0]?.validation[0]?.revision,'abc123')
    assert.throws(()=>store.report(session,{taskId:task.id,assignmentId:task.assignmentId,scopeRevision:1,outcome:'ready',summary:'x',artifacts:[{kind:'url',label:'Bad',value:'javascript:alert(1)'}]}),/artifact/i)
  } finally { store.close();await rm(dir,{recursive:true,force:true}) }
})

test('v1 tasks migrate with a readable backup and retain host links after resources disappear', async () => {
  const dir=await mkdtemp(join(tmpdir(),'workflow-migration-')),path=join(dir,'tasks.sqlite')
  let store=new WorkflowStore(path)
  try {
    const original=store.submitted(session,'project','Original request')
    store.close()
    const writer=new DatabaseSync(path)
    writer.exec('PRAGMA user_version=1')
    writer.prepare('UPDATE tasks SET value=?').run(JSON.stringify({id:original.id,assignmentId:original.assignmentId,sessionId:session,projectId:'project',title:'Original request',request:'Original request',scopeRevision:1,outcome:'working',summary:'',validation:[],updatedAt:123}))
    writer.close()
    store=new WorkflowStore(path)
    assert.equal(store.active(session)?.createdAt,123)
    const backup=new DatabaseSync(path+'.pre-v2.sqlite')
    try { assert.equal((backup.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,1);assert.ok(backup.prepare('SELECT value FROM tasks WHERE id=?').get(original.id)) } finally { backup.close() }
    store.link(session,{repositoryPath:'/missing/repository',worktreePath:'/missing/worktree',branch:'feature',comparisonGroup:'group-a',meetingId:'meeting-a',pullUrl:'https://github.com/o/r/pull/1'})
    store.link(session,{meetingId:'meeting-b'})
    store.link(session,{meetingId:'meeting-a'})
    store.submitted(session,'project','Continue')
    store.close();store=new WorkflowStore(path)
    const retained=store.active(session)!
    assert.equal(retained.id,original.id)
    assert.equal(retained.request,'Original request')
    assert.equal(retained.worktreePath,'/missing/worktree')
    assert.equal(retained.comparisonGroup,'group-a')
    assert.deepEqual(retained.meetingIds,['meeting-a','meeting-b'])
    assert.throws(()=>store.report(session,{taskId:original.id,assignmentId:original.assignmentId,scopeRevision:1,outcome:'ready',summary:'x',origin:'automation'}),/Unknown/)
  } finally { store.close();await rm(dir,{recursive:true,force:true}) }
})

test('manual adoption and replacement stay unknown until submission, rotate assignments and delete only terminal records',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'workflow-manual-')),store=new WorkflowStore(join(dir,'tasks.sqlite'))
  try {
    const adopted=store.manual(session,'project','Existing conversation',false,{worktreePath:join(dir,'worktree')})
    assert.equal(adopted.origin,'adopted');assert.equal(adopted.outcome,'unknown');assert.equal(adopted.request,'')
    assert.throws(()=>store.manual(session,'project','Duplicate',false),/already/)
    assert.throws(()=>store.remove(adopted.id),/Only/)
    assert.throws(()=>store.manual(session,'project','Bad replacement',true,{origin:'invalid' as 'human',branch:'x'.repeat(17_000)}),/Invalid/)
    assert.equal(store.active(session)?.id,adopted.id,'a failed replacement rolls back the old terminal transition')
    const next=store.manual(session,'project','New task',true)
    assert.equal(store.list().find(task=>task.id===adopted.id)?.outcome,'cancelled')
    assert.notEqual(next.assignmentId,adopted.assignmentId)
    assert.throws(()=>store.report(session,{taskId:adopted.id,assignmentId:adopted.assignmentId,scopeRevision:1,outcome:'ready',summary:'Old worker'}),/Stale/)
    store.submitted(session,'project','Actual submitted request')
    assert.equal(store.active(session)?.request,'Actual submitted request')
    assert.equal(store.active(session)?.title,'New task')
    assert.equal(store.active(session)?.outcome,'working')
    store.manualOutcome(next.id,'ready');assert.equal(store.active(session)?.outcome,'ready')
    store.remove(adopted.id)
    assert.equal(store.list().length,1)
    assert.equal(store.active(session)?.id,next.id)
    assert.throws(()=>store.manualOutcome(adopted.id,'working'),/Invalid/)
  }finally{store.close();await rm(dir,{recursive:true,force:true})}
})

test('a replaced worker cannot obtain fresh task IDs and report before a verified new submission',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'workflow-unsubmitted-')),store=new WorkflowStore(join(directory,'tasks.sqlite'))
  try{
    store.submitted(session,'project','Old work')
    const next=store.manual(session,'project','New work',true)
    const report={taskId:next.id,assignmentId:next.assignmentId,scopeRevision:1,outcome:'ready',summary:'Old worker result'}
    assert.throws(()=>store.report(session,report),/submitted/)
    assert.equal(store.active(session)?.outcome,'unknown')
    store.submitted(session,'project','Verified new request')
    assert.equal(store.report(session,report).outcome,'ready')
  }finally{store.close();await rm(directory,{recursive:true,force:true})}
})

test('cached task views isolate callers and observe local writes and external SQLite commits',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'workflow-cache-')),path=join(directory,'tasks.sqlite'),store=new WorkflowStore(path)
  try{
    const task=store.submitted(session,'project','Original request')
    const first=store.list();first[0]!.title='Unpersisted mutation';first[0]!.validation.push({name:'Forged',status:'passed'})
    assert.notEqual(store.list()[0]?.title,'Unpersisted mutation');assert.equal(store.list()[0]?.validation.length,0)
    const writer=new DatabaseSync(path)
    try{
      writer.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify({...task,title:'Externally updated'}),task.id)
      assert.equal(store.list()[0]?.title,'Externally updated')
      writer.prepare('UPDATE tasks SET value=? WHERE id=?').run('null',task.id)
      assert.throws(()=>store.list(),/Invalid/)
      writer.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(task),task.id)
      assert.equal(store.list()[0]?.title,task.title)
    }finally{writer.close()}
    store.manualOutcome(task.id,'blocked');assert.equal(store.list()[0]?.outcome,'blocked')
    store.finish(task.id,'completed');assert.equal(store.list()[0]?.outcome,'completed')
    store.remove(task.id);assert.deepEqual(store.list(),[])
  }finally{store.close();await rm(directory,{recursive:true,force:true})}
})
test('tasks persist, reports bind to assignment, and only manual completion ends a task', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-test-'))
  const path = join(dir, 'workflows.sqlite')
  let store = new WorkflowStore(path)
  try {
    const task = store.submitted(session, 'project', 'Fix token=fixture-secret')
    assert.equal(task.request, 'Fix token=[REDACTED]')
    const report = { taskId: task.id, assignmentId: task.assignmentId, scopeRevision: 1, outcome: 'ready', summary: 'pass\u200bword=fixture-private', validation: [{ name: 'Checks token=fixture-check', status: 'not-run' }] }
    assert.throws(() => store.report(session, { ...report, assignmentId: 'foreign' }), /Stale/)
    assert.throws(() => store.report(session, { ...report, outcome: 'completed' }), /Invalid/)
    assert.throws(() => store.report(session, { ...report, permissions: 'all' }), /Unknown/)
    assert.equal(store.report(session, report).summary, 'password=[REDACTED]')
    assert.equal(store.active(session)?.validation[0]?.name, 'Checks token=[REDACTED]')
    store.close()
    store = new WorkflowStore(path)
    assert.equal(store.active(session)?.outcome, 'ready')
    assert.equal(store.submitted(session, 'project', 'Continue').id, task.id)
    assert.equal(store.active(session)?.outcome, 'working')
    store.finish(task.id, 'completed')
    assert.equal(store.active(session), null)
    assert.notEqual(store.submitted(session, 'project', 'Next task'.repeat(20_000)).id, task.id)
    store.close()
    store = new WorkflowStore(path)
    assert.equal(store.list().length, 2)
    const bytes = await readFile(path)
    assert.equal(bytes.includes(Buffer.from('fixture-secret')), false)
    assert.equal(bytes.includes(Buffer.from('fixture-private')), false)
    const writer = new DatabaseSync(path)
    try { writer.prepare('UPDATE tasks SET value=? WHERE active=1').run('null') } finally { writer.close() }
    assert.throws(() => store.list(), /Invalid stored/)
    assert.throws(() => store.active(session), /Invalid stored/)
  } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
})

test('retention prunes terminal history and a full active set leaves reporting and completion usable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-retention-'))
  const history = new WorkflowStore(join(dir,'history.sqlite'))
  const active = new WorkflowStore(join(dir,'active.sqlite'))
  try {
    const retained = history.submitted('retained','project','Keep this active')
    for (let n=0;n<999;n++) {
      const task = history.submitted('history','project',`Finished ${n}`)
      history.finish(task.id,n%2 ? 'completed' : 'cancelled')
    }
    assert.equal(history.list().length,1000)
    history.submitted('new','project','New work')
    assert.ok(history.list().length<=1000)
    assert.equal(history.active('retained')?.id,retained.id)
    assert.ok(!history.list().some(task => task.request === 'Finished 0'))
    for(let n=0;n<1000;n++) active.submitted(`session-${n}`,'project',`Active ${n}`)
    assert.throws(() => active.submitted('overflow','project','New work'),WorkflowTaskLimitError)
    const task=active.active('session-0')!
    active.report(task.sessionId,{taskId:task.id,assignmentId:task.assignmentId,scopeRevision:1,outcome:'ready',summary:'Ready'})
    assert.equal(active.active(task.sessionId)?.outcome,'ready')
    active.finish(task.id,'completed')
    assert.ok(active.submitted('overflow','project','Retry after freeing space'))
    assert.equal(active.list().length,1000)
  } finally { history.close();active.close();await rm(dir,{recursive:true,force:true}) }
})
