import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkflowResources} from './workflow-resources.js'
import type {WorkflowTask} from './workflow-types.js'
import {mkdtemp,mkdir,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const task=(id:string,path:string):WorkflowTask=>({id,sessionId:id,projectId:'p',title:id,request:'',assignmentId:id,scopeRevision:1,outcome:'working',summary:'',validation:[],updatedAt:1,worktreePath:path})
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve))

test('a removed real resource is reported missing and is never recreated',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'workflow-resource-')),path=join(directory,'worktree')
  let now=1,changed:()=>void=()=>{}
  const observer=new WorkflowResources(async path=>{try{return (await stat(path)).isDirectory()}catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT'?false:null}},()=>changed(),()=>now)
  try{
    await mkdir(path)
    const observed=new Promise<void>(resolve=>{changed=resolve})
    observer.views([task('real',path)],new Set());await observed
    assert.equal(observer.views([task('real',path)],new Set())[0]?.resources?.worktree,'present')
    await settle();await rm(path,{recursive:true});now+=60_001
    const rechecked=new Promise<void>(resolve=>{changed=resolve})
    observer.views([task('real',path)],new Set());await rechecked
    assert.equal(observer.views([task('real',path)],new Set())[0]?.resources?.worktree,'missing')
    await assert.rejects(stat(path),{code:'ENOENT'})
  }finally{observer.close();await rm(directory,{recursive:true,force:true})}
})

test('resource observations distinguish missing from unknown without starting a session or recreating paths',async()=>{
  const reads:string[]=[],observer=new WorkflowResources(async path=>{reads.push(path);return path==='/present'?true:path==='/missing'?false:null},()=>{})
  const tasks=[task('a','/present'),task('b','/missing'),task('c','/denied')]
  assert.equal(observer.views(tasks,new Set(['a']))[0]?.resources?.worktree,'unknown')
  await settle()
  const views=observer.views(tasks,new Set(['a']))
  assert.deepEqual(views.map(task=>task.resources?.worktree),['present','missing','unknown'])
  assert.deepEqual(views.map(task=>task.resources?.session),['open','closed','closed'])
  assert.equal(reads.length,3)
  observer.close()
})

test('timed-out reads retain their concurrency slots and stale path observations never replace newer identities',async()=>{
  const reads:string[]=[],release=new Map<string,(exists:boolean)=>void>()
  const observer=new WorkflowResources(path=>{reads.push(path);return new Promise(resolve=>release.set(path,resolve))},()=>{},Date.now,5)
  const tasks=Array.from({length:6},(_,n)=>task(String(n),`/path-${n}`))
  observer.views(tasks,new Set());await settle();assert.equal(reads.length,4)
  await new Promise(resolve=>setTimeout(resolve,20))
  observer.views(tasks,new Set());await settle();assert.equal(reads.length,4,'a timeout does not release an underlying read slot')
  const changed=[{...tasks[0]!,worktreePath:'/replacement'},...tasks.slice(1)]
  observer.views(changed,new Set());release.get('/path-0')!(true);await settle()
  assert.equal(observer.views(changed,new Set())[0]?.resources?.worktree,'unknown')
  assert.ok(reads.length<=5)
  for(const finish of release.values())finish(false)
  await settle();await settle()
  release.get('/replacement')?.(true);release.get('/path-5')?.(false);await settle()
  observer.close()
})

test('a late answer for an old path cannot be displayed for a replacement path',async()=>{
  const releases=new Map<string,(exists:boolean)=>void>(),observer=new WorkflowResources(path=>new Promise(resolve=>releases.set(path,resolve)),()=>{},Date.now,1000)
  observer.views([task('a','/old')],new Set());await settle()
  observer.views([task('a','/new')],new Set());releases.get('/old')!(true);await settle()
  assert.equal(observer.views([task('a','/new')],new Set())[0]?.resources?.worktree,'unknown')
  releases.get('/new')!(false);await settle()
  assert.equal(observer.views([task('a','/new')],new Set())[0]?.resources?.worktree,'missing')
  observer.close()
})
