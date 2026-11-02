import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkflowNotifications,type WorkflowNotice} from './workflow-notifications.js'
import type {AttentionItem} from './workflow-attention.js'
import {workflowAttention} from './workflow-attention.js'
import type {WorkflowTask} from './workflow-types.js'
import type {DesktopSessionTab} from './types.js'
const item=(id:string,key=id):AttentionItem=>({tabId:id,key,title:'token=fixture-secret',reasons:['Ready for review']})

test('restored evidence is silent, new background outcomes coalesce and cleared episodes can notify again',()=>{
  const notices:WorkflowNotice[]=[],observer=new WorkflowNotifications(()=>true,notice=>notices.push(notice))
  observer.prime([item('old')]);observer.update([item('old')],true);observer.flush();assert.equal(notices.length,0)
  observer.update([item('old'),item('a')],true);observer.update([item('old'),item('a'),item('b')],true)
  observer.flush();assert.equal(notices.length,1);assert.equal(notices[0]?.body,'2 sessions or tasks need attention.')
  observer.update([],true);observer.update([item('a')],true);observer.flush()
  assert.equal(notices.length,2);assert.match(notices[1]!.body,/token=\[REDACTED\].*Ready for review/);assert.doesNotMatch(notices[1]!.body,/fixture-secret/)
  observer.close()
})

test('foreground, disabled and resolved evidence does not notify and source text cannot become a reason',()=>{
  let background=false;const notices:WorkflowNotice[]=[],observer=new WorkflowNotifications(()=>background,notice=>notices.push(notice))
  observer.prime([]);observer.update([item('a')],true);background=true;observer.update([item('a')],true);observer.flush();assert.equal(notices.length,0)
  observer.update([item('b')],false);observer.update([item('b')],true);observer.flush();assert.equal(notices.length,0)
  observer.update([item('c')],true);observer.update([],true);observer.flush();assert.equal(notices.length,0)
  observer.update([{...item('d'),reasons:['question secret text' as 'Ready for review']}],true);observer.flush();assert.equal(notices.length,0)
  observer.close()
})

test('closing a task tab and clearing an approval do not notify an already known outcome again',()=>{
  const task:WorkflowTask={id:'task',sessionId:'session',projectId:'project',title:'Review result',request:'',assignmentId:'assignment',scopeRevision:1,outcome:'ready',summary:'',validation:[],createdAt:1,updatedAt:1}
  const tab={id:'tab',lastSessionId:'session',title:'Session',status:'running'} as DesktopSessionTab
  const notices:WorkflowNotice[]=[],observer=new WorkflowNotifications(()=>true,notice=>notices.push(notice))
  observer.prime(workflowAttention([tab],[],[task]))
  observer.update(workflowAttention([{...tab,status:'approval-needed'}],[],[task]),true)
  observer.update(workflowAttention([tab],[],[task]),true);observer.flush()
  assert.equal(notices.length,0,'approval resolved before a coalesced notice is shown')
  observer.update(workflowAttention([],[],[task]),true);observer.flush()
  assert.equal(notices.length,0,'the task evidence is stable across a presentation change')
  observer.close()
})
