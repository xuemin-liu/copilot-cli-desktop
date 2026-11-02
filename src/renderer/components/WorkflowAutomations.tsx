import {useState,type JSX} from 'react'
import type {WorkspaceProfile} from '../../main/types.js'
import type {AutomationRule,AutomationPreview} from '../../main/workflow-automations.js'
export function WorkflowAutomations({profiles,rules,previews,paused,pausedProjects,error}:{profiles:WorkspaceProfile[];rules:AutomationRule[];previews:AutomationPreview[];paused:boolean;pausedProjects:string[];error?:string|null}):JSX.Element {
  const [project,setProject]=useState(profiles[0]?.id??''),[repository,setRepository]=useState(''),[template,setTemplate]=useState<'assigned-issue'|'default-ci'>('assigned-issue'),[actors,setActors]=useState('')
  const [failure,setFailure]=useState<string|null>(null),[pending,setPending]=useState(false),[limit,setLimit]=useState(30)
  const [editing,setEditing]=useState<string|undefined>(undefined)
  const run=(action:()=>Promise<unknown>):void=>{setPending(true);setFailure(null);void action().catch(e=>setFailure(e instanceof Error?e.message:'Automation settings could not be saved')).finally(()=>setPending(false))}
  return <details className="workflow-automations"><summary>Automation · {paused?'Paused':`${rules.length} rules`}</summary>
    {(failure||error)&&<p role="alert">{failure||error}</p>}
    <button type="button" disabled={pending} onClick={()=>run(()=>window.copilotDesktop.pauseAutomatic(!paused))}>{paused?'Resume all automatic work':'Pause all automatic work'}</button>
    <p>Pause applies to task follow-ups and rule-created work, including tray sessions. Resume establishes a fresh baseline.</p>
    <label>Project<select value={project} onChange={event=>setProject(event.target.value)}>{profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <button type="button" disabled={pending||!project} onClick={()=>run(()=>window.copilotDesktop.pauseAutomatic(!pausedProjects.includes(project),project))}>{pausedProjects.includes(project)?'Resume project':'Pause project'}</button>
    <form onSubmit={event=>{event.preventDefault();run(async()=>{await window.copilotDesktop.configureAutomation(project,repository,template,actors.split(/[\s,]+/).filter(Boolean),editing);setEditing(undefined)})}}>
      <label>GitHub repository<input required value={repository} placeholder="owner/repository" onChange={event=>setRepository(event.target.value)} /></label>
      <label>Investigation template<select value={template} onChange={event=>setTemplate(event.target.value as typeof template)}><option value="assigned-issue">New issue assigned to my GitHub account</option><option value="default-ci">Failed default-branch CI check</option></select></label>
      <label>{template==='assigned-issue'?'Allowed assigner logins':'Allowed GitHub app slugs'}<input required value={actors} onChange={event=>setActors(event.target.value)} placeholder={template==='assigned-issue'?'teammate, trusted-bot[bot]':'github-actions'} /></label>
      <p>Creates a Preview rule. Preview launches no worker. Automatic and Start preview create a restricted read/search investigation in a dedicated worktree, using this project’s model. They produce proposed next steps for review. Limits: three starts per day and ten per rule; two active workers per project, ten minutes per turn. Model costs are not capped.</p>
      <button disabled={pending||!profiles.length} type="submit">{editing?'Save changes in Preview':'Create Preview rule'}</button>
      {editing&&<button type="button" onClick={()=>setEditing(undefined)}>Cancel editing</button>}
    </form>
    <ul>{rules.map(rule=><li key={rule.id}><strong>{rule.repository} · {rule.template}</strong><p>{rule.mode} · {rule.health} · {rule.launches}/10 starts · actors: {rule.actors.map(a=>a.login).join(', ')}</p>
      <button disabled={pending} type="button" onClick={()=>{setEditing(rule.id);setProject(rule.projectId);setRepository(rule.repository);setTemplate(rule.template);setActors(rule.actors.map(a=>a.login).join(', '))}}>Edit rule</button>
      <button disabled={pending||rule.mode==='off'} type="button" onClick={()=>run(()=>window.copilotDesktop.automationAction(rule.id,'off'))}>Off</button>
      <button disabled={pending||rule.mode==='preview'} type="button" onClick={()=>run(()=>window.copilotDesktop.automationAction(rule.id,'preview'))}>Preview</button>
      <button disabled={pending||rule.mode==='automatic'} type="button" onClick={()=>run(()=>window.copilotDesktop.automationAction(rule.id,'automatic'))}>Enable Automatic for new events</button>
    </li>)}</ul>
    <h3>Preview history · {previews.length}</h3>
    <ul>{previews.slice(0,limit).map(p=><li key={p.id}><strong>{p.title}</strong><p>{p.summary}</p><span>{p.state}</span>
      {p.state==='preview'&&rules.some(r=>r.id===p.ruleId&&r.revision===p.revision&&r.mode!=='off')&&<button disabled={pending||paused} type="button" onClick={()=>run(()=>window.copilotDesktop.automationAction(p.id,'start'))}>Start selected preview</button>}
      {p.sessionId&&<button type="button" onClick={()=>run(()=>window.copilotDesktop.openSessionHistory(p.sessionId!))}>Open task session</button>}
      {p.state==='uncertain'&&<p>Launch may have created a session or checkout. Inspect Tasks and sessions; this event will not be launched again automatically.</p>}
    </li>)}</ul>
    {previews.length>limit&&<button type="button" onClick={()=>setLimit(n=>n+30)}>Show more previews</button>}
  </details>
}
