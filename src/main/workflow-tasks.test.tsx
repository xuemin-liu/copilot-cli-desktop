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

test('unsupported existing conversations offer manual tracking and supported resumption, with history-only deletion',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'workflow-manual-ui-')),store=new WorkflowStore(join(dir,'tasks.sqlite'))
  try {
    const tab={id:'open-tab',title:'Existing conversation',lastSessionId:'existing-session',cliVersion:'1.0.82',sessionPermissionPreset:'default',workspaceProfileId:'project'} as import('./types.js').DesktopSessionTab
    const empty=renderToStaticMarkup(<WorkflowTasks tasks={[]} tabs={[tab]} />)
    assert.match(empty,/Track this conversation/)
    const task=store.manual('existing-session','project','Existing work',false)
    const active=renderToStaticMarkup(<WorkflowTasks tasks={store.list()} tabs={[tab]} installedCliVersion="1.0.105" onRestart={()=>{}} />)
    assert.match(active,/Resume with task support/)
    assert.match(active,/Recorded outcome/)
    assert.match(active,/End current task and track another/)
    assert.doesNotMatch(active,/Delete task history/)
    store.finish(task.id,'completed')
    const history=renderToStaticMarkup(<WorkflowTasks tasks={store.list()} />)
    assert.match(history,/Delete task history/)
    assert.match(history,/sessions, files, worktrees and handoff evidence are kept/)
  }finally{store.close();await rm(dir,{recursive:true,force:true})}
})
