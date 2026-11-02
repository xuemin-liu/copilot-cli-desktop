import { createHash } from 'node:crypto'
import { validGithubRepository, type GithubApi } from './workflow-github.js'
export type AutomationTemplate='assigned-issue'|'default-ci'
export interface AutomationActor {id:number;login:string;kind:'user'|'app'}
export interface AutomationEvent {key:string;version:string;actorId:number;at:number;title:string;body:string;head:string;branch:string}
const hash=(v:unknown):string=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Invalid GitHub source');return v as Record<string,unknown>}
const str=(v:unknown):string=>{if(typeof v!=='string')throw new Error('Invalid GitHub source text');return v}
const id=(v:unknown):number=>{if(!Number.isSafeInteger(v)||Number(v)<1)throw new Error('Invalid GitHub identity');return v as number}
const at=(v:unknown):number=>{const n=Date.parse(str(v));if(!Number.isFinite(n))throw new Error('Invalid GitHub event time');return n}
async function pages(api:GithubApi,path:string,field?:string):Promise<Record<string,unknown>[]> {
  const data=await api(path,true)
  if(!Array.isArray(data))throw new Error('Incomplete GitHub source')
  const rows=data.flatMap(page=>{const values=field?object(page)[field]:page;if(!Array.isArray(values))throw new Error('Invalid GitHub page');return values.map(object)})
  if(rows.length>1000)throw new Error('GitHub source limit reached')
  return rows
}
export async function resolveAutomationActors(api:GithubApi,template:AutomationTemplate,names:readonly string[]):Promise<AutomationActor[]> {
  if(!Array.isArray(names)||names.length<1||names.length>10)throw new Error('Name one to ten allowed actors')
  const actors:AutomationActor[]=[]
  for(const name of new Set(names)){
    if(typeof name!=='string'||!/^[a-zA-Z0-9-]+(?:\[bot\])?$/.test(name)||name.length>100)throw new Error('Use GitHub logins or app slugs')
    const actor=object(await api(`${template==='assigned-issue'?'users':'apps'}/${encodeURIComponent(name)}`))
    const login=str(template==='assigned-issue'?actor.login:actor.slug)
    if(login.toLowerCase()!==name.toLowerCase())throw new Error('GitHub actor identity changed')
    actors.push({id:id(actor.id),login,kind:template==='assigned-issue'?'user':'app'})
  }
  return actors
}
/** Current eligible evidence only; assignment history is rechecked against the current open issue. */
export async function readAutomationEvents(api:GithubApi,repository:string,template:AutomationTemplate):Promise<AutomationEvent[]> {
  if(!validGithubRepository(repository))throw new Error('Use owner/repository')
  const root=`repos/${repository}`,repo=object(await api(root)),branch=str(repo.default_branch)
  const commit=object(await api(`${root}/commits/${encodeURIComponent(branch)}`)),head=str(commit.sha)
  if(!/^[a-f0-9]{40,64}$/.test(head))throw new Error('Invalid default branch revision')
  const result:AutomationEvent[]=[]
  if(template==='assigned-issue') {
    const viewer=id(object(await api('user')).id)
    const events=await pages(api,`${root}/issues/events?per_page=100`)
    // Bound detailed issue reads independently of the source's history size.
    const assignments=events.filter(e=>e.event==='assigned'&&e.assignee&&object(e.assignee).id===viewer)
    if(assignments.length>30)throw new Error('Too many assignment events; narrow the repository source')
    const latest=new Map<number,Record<string,unknown>>()
    for(const event of assignments){const number=id(object(event.issue).number);if(!latest.has(number)||id(event.id)>id(latest.get(number)!.id))latest.set(number,event)}
    for(const [number,event] of latest){
      const issue=object(await api(`${root}/issues/${number}`))
      if(issue.state!=='open'||issue.pull_request||!Array.isArray(issue.assignees)||!issue.assignees.some(a=>object(a).id===viewer))continue
      const actor=id(object(event.actor).id),title=str(issue.title),body=typeof issue.body==='string'?issue.body:''
      result.push({key:`github/${repository.toLowerCase()}/issue/${number}`,version:hash([event.id]),actorId:actor,
        at:at(event.created_at),title:`Investigate issue #${number}`,body:`Issue #${number}: ${title}\n${body.slice(0,5000)}`,head,branch})
    }
  }else {
    const checks=await pages(api,`${root}/commits/${head}/check-runs?per_page=100`,'check_runs')
    const latest=new Map<string,Record<string,unknown>>()
    for(const check of checks){const app=id(object(check.app).id),key=`${app}/${str(check.name)}`;if(!latest.has(key)||id(check.id)>id(latest.get(key)!.id))latest.set(key,check)}
    for(const check of latest.values())if(check.status==='completed'&&['failure','timed_out'].includes(String(check.conclusion))){
      const actorId=id(object(check.app).id),name=str(check.name)
      result.push({key:`github/${repository.toLowerCase()}/ci/${head}/${hash([actorId,name]).slice(0,24)}`,version:hash([check.id,check.completed_at,check.conclusion]),actorId,
        at:at(check.completed_at),title:'Investigate default-branch CI failure',body:`Check ${name} failed on default branch ${branch} at ${head}. Inspect the cause and propose a bounded fix.`,head,branch})
    }
  }
  const verified=object(await api(`${root}/commits/${encodeURIComponent(branch)}`))
  if(verified.sha!==head)throw new Error('Default branch changed during collection')
  return result
}
