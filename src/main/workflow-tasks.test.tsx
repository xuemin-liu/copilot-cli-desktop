import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { renderToStaticMarkup } from 'react-dom/server'
import { WorkflowStore } from './workflow-store.js'
import { WorkflowTasks } from '../renderer/components/WorkflowTasks.js'
import {TaskFollowups} from '../renderer/components/WorkflowFollowups.js'
import type {FollowupDefault} from './workflow-followups.js'

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
    // A tab that runs another CLI has a session id too, but its conversation is not Copilot's: it is never offered.
    const claude={...tab,id:'claude-tab',title:'Claude conversation',lastSessionId:'923c0d6e-59f2-44aa-874e-1bc7aebaefd3',cli:'claude'} as import('./types.js').DesktopSessionTab
    assert.equal(renderToStaticMarkup(<WorkflowTasks tasks={[]} tabs={[claude]} />),'')
    const mixed=renderToStaticMarkup(<WorkflowTasks tasks={[]} tabs={[tab,claude]} />)
    assert.match(mixed,/Existing conversation/)
    assert.doesNotMatch(mixed,/Claude conversation/)
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

test('project defaults are offered only to newer tasks and still require explicit enrollment',()=>{
  const defaults:FollowupDefault={revision:'default-revision',projectId:'project',repository:'owner/repo',reviewers:[{id:7,login:'reviewer'}],failedChecks:true,completeOnMerge:true,activatedAt:100}
  const old=renderToStaticMarkup(<TaskFollowups taskId="old" projectId="project" createdAt={99} projectDefault={defaults} />)
  const fresh=renderToStaticMarkup(<TaskFollowups taskId="new" projectId="project" createdAt={101} projectDefault={defaults} />)
  assert.doesNotMatch(old,/Use project defaults for this task/)
  assert.match(fresh,/Use project defaults for this task/)
  assert.match(fresh,/Enable follow-ups for this task/)
  assert.match(fresh,/verified merged/)
  assert.doesNotMatch(fresh,/<input[^>]*checked=""/,'the template has not silently enabled any checkboxes')
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
