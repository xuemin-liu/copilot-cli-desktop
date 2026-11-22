import { useState, type JSX } from 'react'
import type { FollowupGrant,FollowupDefault } from '../../main/workflow-followups.js'
import type { PrPostView } from '../../main/types.js'

const short=(sha:string):string=>sha.slice(0,12)

/** A fix loop's state in words: its budget, the approval waiting for the person, and replies not yet settled. */
function FixLoopStatus({grant,posts,run,pending}:{grant:FollowupGrant;posts:readonly PrPostView[];run:(action:()=>Promise<void>)=>void;pending:boolean}):JSX.Element{
  const approval=grant.approval
  return <>
    <p>Fix loop · {grant.repository} #{grant.number} · {grant.total}/{grant.limit??30} continuations · Reviewers: {grant.reviewers.map(r=>r.login).join(', ')}</p>
    {grant.health==='approved'&&<p>Approved at {short(grant.head)}. The loop has ended; Desktop does not merge the PR.</p>}
    {approval&&grant.enabled&&<div className="workflow-approval">
      <p>{approval.kind==='review'?'A formal approval':'A comment'} approves head {short(approval.head)} (base {short(approval.base)}). GitHub does not record which base an outside review saw, so confirm it yourself before the loop ends.</p>
      <button disabled={pending} type="button" onClick={()=>run(()=>window.copilotDesktop.confirmFollowupApproval(grant.id))}>Confirm approval</button>
    </div>}
    {grant.health==='limit'&&grant.enabled&&<button disabled={pending} type="button" onClick={()=>run(()=>window.copilotDesktop.extendFollowup(grant.id))}>Allow ten more</button>}
    {posts.map(post=>post.state==='uncertain'
      ?<p key={post.id}>A {post.kind==='reply'?`reply to comment ${post.target}`:'conversation comment'} may not have reached GitHub. Look at the PR, then <button disabled={pending} type="button" onClick={()=>run(()=>window.copilotDesktop.dismissPrPost(post.id))}>Mark as checked</button>. Desktop never posts it again by itself.</p>
      :<p key={post.id}>Checking whether a reply reached GitHub…</p>)}
  </>
}

/** A review loop's state: what it reviewed, what its checkout holds, and its budget. */
function ReviewLoopStatus({grant}:{grant:FollowupGrant}):JSX.Element{
  return <>
    <p>Review loop · {grant.repository} #{grant.number} · {grant.total}/{grant.limit??30} continuations</p>
    <p>{grant.reviewedHead?`Last review posted for head ${short(grant.reviewedHead)}.`:'No review posted yet.'} {grant.checkedOut?`Its sandboxed checkout is at ${short(grant.checkedOut)}.`:''}</p>
    {grant.health==='closed'&&<p>The PR was merged or closed; the loop has ended. Desktop never merges.</p>}
  </>
}

/**
 * Review a PR: the desktop clones it into a folder of its own and starts a sandboxed reviewer session there. Its own
 * consent, because the session runs the PR's code.
 */
export function ReviewPrForm():JSX.Element{
  const [url,setUrl]=useState(''),[consent,setConsent]=useState(false),[error,setError]=useState<string|null>(null),[pending,setPending]=useState(false)
  return <details className="workflow-review-start"><summary>Review a PR</summary>
    <form onSubmit={event=>{event.preventDefault();setPending(true);setError(null)
      void window.copilotDesktop.startPrReview(url,consent).then(()=>{setUrl('');setConsent(false)}).catch(error=>setError(error instanceof Error?error.message:'The review could not start')).finally(()=>setPending(false))}}>
      <label>PR URL<input required type="url" value={url} onChange={event=>setUrl(event.target.value)} placeholder="https://github.com/owner/repo/pull/123" /></label>
      <label><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)} />The review session may run this PR's code (its build and tests), with network access, in Copilot's sandbox</label>
      <p>Desktop clones the PR into a folder of its own and starts a Copilot session there inside Copilot CLI's command sandbox, with its own Copilot home and no GitHub login: it reads the PR and posts its reviews only through Desktop, which checks each one. It reviews again when the author replies or pushes, and approves only a head with nothing left to fix. Only your own same-repository PRs, for now; a PR from a fork never starts. A project whose origin is the PR's repository must be open in Desktop. Keep Desktop running.</p>
      <button disabled={pending||!consent} type="submit">Start the review loop</button>
    </form>
    {error&&<p role="alert">{error}</p>}
  </details>
}

export function TaskFollowups({taskId,grant,projectId,createdAt,projectDefault,posts=[]}:{taskId:string;grant?:FollowupGrant|undefined;projectId?:string;createdAt?:number|undefined;projectDefault?:FollowupDefault|undefined;posts?:readonly PrPostView[]}):JSX.Element {
  const [url,setUrl]=useState(''),[reviewers,setReviewers]=useState(''),[checks,setChecks]=useState(false)
  const [completeOnMerge,setCompleteOnMerge]=useState(false)
  const [role,setRole]=useState<'follow-up'|'author'>('follow-up'),[existing,setExisting]=useState(false)
  const eligible=projectDefault&&createdAt!==undefined&&createdAt>projectDefault.activatedAt
  const [error,setError]=useState<string|null>(null),[pending,setPending]=useState(false)
  const run=(action:()=>Promise<void>):void=>{
    setPending(true);setError(null)
    void action().catch(error=>setError(error instanceof Error?error.message:'Follow-up settings could not be saved')).finally(()=>setPending(false))
  }
  const fixLoop=grant?.role==='author',reviewLoop=grant?.role==='reviewer'
  const grantPosts=grant?posts.filter(post=>post.grantId===grant.id):[]
  return <details className="workflow-followups"><summary>{fixLoop?'Fix loop':reviewLoop?'Review loop':'GitHub follow-ups'}{grant?` · ${grant.health}`:''}</summary>
    {grant&&fixLoop&&<FixLoopStatus grant={grant} posts={grantPosts} run={run} pending={pending} />}
    {grant&&reviewLoop&&<><ReviewLoopStatus grant={grant} />{grantPosts.map(post=>post.state==='uncertain'
      ?<p key={post.id}>A {post.kind} may not have reached GitHub. Look at the PR, then <button disabled={pending} type="button" onClick={()=>run(()=>window.copilotDesktop.dismissPrPost(post.id))}>Mark as checked</button>.</p>
      :<p key={post.id}>Checking whether a {post.kind} reached GitHub…</p>)}
      {grant.health==='limit'&&grant.enabled&&<button disabled={pending} type="button" onClick={()=>run(()=>window.copilotDesktop.extendFollowup(grant.id))}>Allow ten more</button>}</>}
    {grant&&!fixLoop&&!reviewLoop&&<p>{grant.repository} #{grant.number} · Checks: {grant.checks} · {grant.total}/10 continuations
      {grant.reviewers.length?` · Reviewers: ${grant.reviewers.map(r=>r.login).join(', ')}`:''}</p>}
    {projectDefault&&<p>Project default: {projectDefault.repository}. Offered only to tasks created after it was saved; no existing task is enrolled automatically.</p>}
    {projectDefault&&projectId&&<button disabled={pending} type="button" onClick={()=>run(()=>window.copilotDesktop.removeFollowupDefault(projectId))}>Remove project default</button>}
    {grant?.completeOnMerge&&<p>Verified PR merge completes this task. Desktop does not merge the PR.</p>}
    {grant?.health==='scope-changed'&&<p>Session permissions or scope changed. Reconcile the checkout and re-enroll to continue.</p>}
    {grant?.health==='needs-person'&&<p>Open the linked session and resolve its input, binding or permission state before continuing.</p>}
    {grant?.enabled?<button disabled={pending} type="button" onClick={()=>run(()=>window.copilotDesktop.pauseFollowup(grant.id))}>{fixLoop?'Stop the fix loop':reviewLoop?'Stop the review loop':'Pause follow-ups'}</button>:reviewLoop?null:<form onSubmit={event=>{
      event.preventDefault()
      const names=reviewers.split(/[\s,]+/).filter(Boolean)
      run(()=>window.copilotDesktop.enrollFollowup(taskId,url,names,checks,completeOnMerge,role==='author'?{role:'author',includeExisting:existing}:{}))
    }}>
      <fieldset><legend>What should happen on new feedback?</legend>
        <label><input type="radio" name={`role-${taskId}`} checked={role==='follow-up'} onChange={()=>setRole('follow-up')} />Continue this task (follow-ups)</label>
        <label><input type="radio" name={`role-${taskId}`} checked={role==='author'} onChange={()=>setRole('author')} />Fix review feedback (fix loop)</label>
      </fieldset>
      {eligible&&<button disabled={pending} type="button" onClick={()=>{if(!url.startsWith(`https://github.com/${projectDefault.repository}/pull/`))setUrl('');setReviewers(projectDefault.reviewers.map(actor=>actor.login).join(', '));setChecks(projectDefault.failedChecks);setCompleteOnMerge(projectDefault.completeOnMerge)}}>Use project defaults for this task</button>}
      <label>PR URL<input required type="url" value={url} onChange={event=>setUrl(event.target.value)} placeholder={`https://github.com/${projectDefault?.repository??'owner/repo'}/pull/123`} /></label>
      <label>Allowed reviewer logins<input value={reviewers} onChange={event=>setReviewers(event.target.value)} placeholder="login, reviewer-bot[bot]" /></label>
      <label><input type="checkbox" checked={checks} onChange={event=>setChecks(event.target.checked)} />Continue on failed CI checks</label>
      {role==='author'&&<label><input type="checkbox" checked={existing} onChange={event=>setExisting(event.target.checked)} />Also take the allowed reviewers' feedback already on the PR</label>}
      <label><input type="checkbox" checked={completeOnMerge} onChange={event=>setCompleteOnMerge(event.target.checked)} />Mark this task complete when this PR is verified merged</label>
      {projectId&&role==='follow-up'&&<button disabled={pending} type="button" onClick={()=>run(()=>window.copilotDesktop.saveFollowupDefault(projectId,url,reviewers.split(/[\s,]+/).filter(Boolean),checks,completeOnMerge))}>Save these settings for future tasks</button>}
      {role==='author'
        ?<p>The fix loop continues this task's session on new review feedback, with this session's own tool permissions: they govern its edits, commits and pushes. Unlike follow-ups, it may also post replies on this PR, only through Desktop, which checks the PR, the thread and your GitHub account first; replies start with 🤖. It ends when you confirm an approval of the PR's current head, or when the PR is merged or closed. Limits: three continuations per PR head, thirty in all (you can allow more), thirty minutes per turn. Tool approvals still apply; model costs are not capped. Keep Desktop and the session running.</p>
        :<p>Uses this task’s current local session and permissions. Only new feedback is accepted. Limits: three continuations per PR head, ten total, ten minutes per turn, two workers per project. Tool approvals still apply; unmeasured model costs are not capped. Keep Desktop and the session running.</p>}
      <button disabled={pending} type="submit">{role==='author'?'Start the fix loop for this task':'Enable follow-ups for this task'}</button>
    </form>}
    {error&&<p role="alert">{error}</p>}
  </details>
}
