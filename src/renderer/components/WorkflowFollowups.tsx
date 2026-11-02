import { useState, type JSX } from 'react'
import type { FollowupGrant } from '../../main/workflow-followups.js'

export function TaskFollowups({taskId,grant}:{taskId:string;grant?:FollowupGrant|undefined}):JSX.Element {
  const [url,setUrl]=useState(''),[reviewers,setReviewers]=useState(''),[checks,setChecks]=useState(false)
  const [error,setError]=useState<string|null>(null),[pending,setPending]=useState(false)
  const run=(action:()=>Promise<void>):void=>{
    setPending(true);setError(null)
    void action().catch(error=>setError(error instanceof Error?error.message:'Follow-up settings could not be saved')).finally(()=>setPending(false))
  }
  return <details><summary>GitHub follow-ups{grant?` · ${grant.health}`:''}</summary>
    {grant&&<p>{grant.repository} #{grant.number} · Checks: {grant.checks} · {grant.total}/10 continuations
      {grant.reviewers.length?` · Reviewers: ${grant.reviewers.map(r=>r.login).join(', ')}`:''}</p>}
    {grant?.enabled?<button disabled={pending} type="button" onClick={()=>run(()=>window.copilotDesktop.pauseFollowup(grant.id))}>Pause follow-ups</button>:<form onSubmit={event=>{
      event.preventDefault();run(()=>window.copilotDesktop.enrollFollowup(taskId,url,reviewers.split(/[\s,]+/).filter(Boolean),checks))
    }}>
      <label>PR URL<input required type="url" value={url} onChange={event=>setUrl(event.target.value)} placeholder="https://github.com/owner/repo/pull/123" /></label>
      <label>Allowed reviewer logins<input value={reviewers} onChange={event=>setReviewers(event.target.value)} placeholder="login, reviewer-bot[bot]" /></label>
      <label><input type="checkbox" checked={checks} onChange={event=>setChecks(event.target.checked)} />Continue on failed CI checks</label>
      <p>Uses this task’s current local session and permissions. Only new feedback is accepted. Limits: three continuations per PR head, ten total, ten minutes per turn, two workers per project. Tool approvals still apply; unmeasured model costs are not capped. Keep Desktop and the session running.</p>
      <button disabled={pending} type="submit">Enable follow-ups for this task</button>
    </form>}
    {error&&<p role="alert">{error}</p>}
  </details>
}
