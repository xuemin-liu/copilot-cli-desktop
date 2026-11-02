import { useState, type JSX } from 'react'
import type { FollowupGrant,FollowupDefault } from '../../main/workflow-followups.js'

export function TaskFollowups({taskId,grant,projectId,createdAt,projectDefault}:{taskId:string;grant?:FollowupGrant|undefined;projectId?:string;createdAt?:number|undefined;projectDefault?:FollowupDefault|undefined}):JSX.Element {
  const [url,setUrl]=useState(''),[reviewers,setReviewers]=useState(''),[checks,setChecks]=useState(false)
  const [completeOnMerge,setCompleteOnMerge]=useState(false)
  const eligible=projectDefault&&createdAt!==undefined&&createdAt>projectDefault.activatedAt
  const [error,setError]=useState<string|null>(null),[pending,setPending]=useState(false)
  const run=(action:()=>Promise<void>):void=>{
    setPending(true);setError(null)
    void action().catch(error=>setError(error instanceof Error?error.message:'Follow-up settings could not be saved')).finally(()=>setPending(false))
  }
  return <details className="workflow-followups"><summary>GitHub follow-ups{grant?` · ${grant.health}`:''}</summary>
    {grant&&<p>{grant.repository} #{grant.number} · Checks: {grant.checks} · {grant.total}/10 continuations
      {grant.reviewers.length?` · Reviewers: ${grant.reviewers.map(r=>r.login).join(', ')}`:''}</p>}
    {projectDefault&&<p>Project default: {projectDefault.repository}. Offered only to tasks created after it was saved; no existing task is enrolled automatically.</p>}
    {projectDefault&&projectId&&<button disabled={pending} type="button" onClick={()=>run(()=>window.copilotDesktop.removeFollowupDefault(projectId))}>Remove project default</button>}
    {grant?.completeOnMerge&&<p>Verified PR merge completes this task. Desktop does not merge the PR.</p>}
    {grant?.health==='scope-changed'&&<p>Session permissions or scope changed. Reconcile the checkout and re-enroll to continue.</p>}
    {grant?.health==='needs-person'&&<p>Open the linked session and resolve its input, binding or permission state before continuing.</p>}
    {grant?.enabled?<button disabled={pending} type="button" onClick={()=>run(()=>window.copilotDesktop.pauseFollowup(grant.id))}>Pause follow-ups</button>:<form onSubmit={event=>{
      event.preventDefault();run(()=>window.copilotDesktop.enrollFollowup(taskId,url,reviewers.split(/[\s,]+/).filter(Boolean),checks,completeOnMerge))
    }}>
      {eligible&&<button disabled={pending} type="button" onClick={()=>{if(!url.startsWith(`https://github.com/${projectDefault.repository}/pull/`))setUrl('');setReviewers(projectDefault.reviewers.map(actor=>actor.login).join(', '));setChecks(projectDefault.failedChecks);setCompleteOnMerge(projectDefault.completeOnMerge)}}>Use project defaults for this task</button>}
      <label>PR URL<input required type="url" value={url} onChange={event=>setUrl(event.target.value)} placeholder={`https://github.com/${projectDefault?.repository??'owner/repo'}/pull/123`} /></label>
      <label>Allowed reviewer logins<input value={reviewers} onChange={event=>setReviewers(event.target.value)} placeholder="login, reviewer-bot[bot]" /></label>
      <label><input type="checkbox" checked={checks} onChange={event=>setChecks(event.target.checked)} />Continue on failed CI checks</label>
      <label><input type="checkbox" checked={completeOnMerge} onChange={event=>setCompleteOnMerge(event.target.checked)} />Mark this task complete when this PR is verified merged</label>
      {projectId&&<button disabled={pending} type="button" onClick={()=>run(()=>window.copilotDesktop.saveFollowupDefault(projectId,url,reviewers.split(/[\s,]+/).filter(Boolean),checks,completeOnMerge))}>Save these settings for future tasks</button>}
      <p>Uses this task’s current local session and permissions. Only new feedback is accepted. Limits: three continuations per PR head, ten total, ten minutes per turn, two workers per project. Tool approvals still apply; unmeasured model costs are not capped. Keep Desktop and the session running.</p>
      <button disabled={pending} type="submit">Enable follow-ups for this task</button>
    </form>}
    {error&&<p role="alert">{error}</p>}
  </details>
}
