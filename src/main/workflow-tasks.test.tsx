import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { renderToStaticMarkup } from 'react-dom/server'
import { WorkflowStore } from './workflow-store.js'
import { WorkflowTasks } from '../renderer/components/WorkflowTasks.js'

test('an older active task remains reachable after fifty newer tasks complete', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-history-'))
  const store = new WorkflowStore(join(dir, 'tasks.sqlite'))
  try {
    store.submitted(randomUUID(), 'project', 'Active task A')
    for (let n = 0; n < 50; n++) {
      const task = store.submitted(randomUUID(), 'project', `Finished task ${n}`)
      store.finish(task.id, 'completed')
    }
    const markup = renderToStaticMarkup(<WorkflowTasks tasks={store.list()} />)
    assert.match(markup, /Active task A/)
    assert.equal((markup.match(/Mark complete/g) ?? []).length, 1)
    assert.equal((markup.match(/>End tracking</g) ?? []).length, 1)
  } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
})

test('task details expose questions, validation revisions, host links and report history',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'workflow-details-ui-')),store=new WorkflowStore(join(dir,'tasks.sqlite'))
  try {
    const task=store.submitted(randomUUID(),'project','Original request',{repositoryPath:'/repository',worktreePath:'/worktree',branch:'feature',comparisonGroup:'comparison-a',meetingId:'review-a'})
    store.report(task.sessionId,{taskId:task.id,assignmentId:task.assignmentId,scopeRevision:1,outcome:'needs-input',summary:'Choose behavior',question:'Which rounding policy?',artifacts:[{kind:'url',label:'Review PR',value:'https://github.com/o/r/pull/1'}],validation:[{name:'Tests',status:'not-run',revision:'abc123'}]})
    const markup=renderToStaticMarkup(<WorkflowTasks tasks={store.list()} />)
    for(const label of ['Original request','Which rounding policy?','/worktree','feature','comparison-a','review-a','Review PR','abc123','Report history'])assert.ok(markup.includes(label),label)
  } finally {store.close();await rm(dir,{recursive:true,force:true})}
})

test('untrusted artifact destinations and earlier report references remain visible before navigation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'workflow-artifacts-ui-')),store=new WorkflowStore(join(dir,'tasks.sqlite'))
  try{
    const task=store.submitted(randomUUID(),'project','Review evidence')
    const binding={taskId:task.id,assignmentId:task.assignmentId,scopeRevision:1}
    store.report(task.sessionId,{...binding,outcome:'needs-input',summary:'Baseline',artifacts:[{kind:'path',label:'Baseline evidence report',value:'/reports/baseline.txt'}]})
    store.report(task.sessionId,{...binding,outcome:'ready',summary:'Ready',artifacts:[{kind:'url',label:'Open the PR on GitHub',value:'https://github-login.example.net/session'}]})
    const markup=renderToStaticMarkup(<WorkflowTasks tasks={store.list()} />)
    assert.match(markup,/github-login\.example\.net/)
    assert.match(markup,/Baseline evidence report/)
    assert.match(markup,/\/reports\/baseline\.txt/)
    assert.match(markup,/>Open the PR on GitHub[^<]*github-login\.example\.net/,'the actual destination is visible in the action text')
  }finally{store.close();await rm(dir,{recursive:true,force:true})}
})
