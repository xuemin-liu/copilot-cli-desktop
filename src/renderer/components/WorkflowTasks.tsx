import { useState } from 'react'
import type { JSX } from 'react'
import type { WorkflowTask, TaskAction } from '../../main/workflow-types.js'
import type { DesktopSessionTab } from '../../main/types.js'
import { supportsTaskReporting } from '../../main/workflow-capabilities.js'
import type { FollowupGrant,FollowupDefault } from '../../main/workflow-followups.js'
import { TaskFollowups } from './WorkflowFollowups.js'

export function WorkflowTasks({ tasks, error,followups=[],defaults=[],tabs=[],installedCliVersion=null,onRestart }: { tasks: readonly WorkflowTask[]; error?: string | null;followups?:readonly FollowupGrant[];defaults?:readonly FollowupDefault[];tabs?:readonly DesktopSessionTab[];installedCliVersion?:string|null;onRestart?:(tabId:string)=>void }): JSX.Element | null {
  const [failure, setFailure] = useState<string | null>(null)
  const [historyLimit, setHistoryLimit] = useState(50)
  const [sessionChoice,setSessionChoice]=useState(''),[title,setTitle]=useState(''),[pending,setPending]=useState(false)
  const known=tabs.filter(tab=>tab.lastSessionId)
  if (!tasks.length && !error && !known.length) return null
  const finish = (id: string, action: TaskAction): void => {
    setFailure(null)
    void window.copilotDesktop.taskAction(id, action).catch(() => setFailure('The task could not be updated. Try again.'))
  }
  const chooseTask=(tabId:string,replace:boolean):void=>{
    if(!title.trim()||pending)return
    setFailure(null);setPending(true)
    void window.copilotDesktop.createTask(tabId,title.trim(),replace).then(()=>setTitle('')).catch(error=>setFailure(error instanceof Error?error.message:'The task could not be created.')).finally(()=>setPending(false))
  }
  const active = tasks.filter(task => task.outcome !== 'completed' && task.outcome !== 'cancelled')
  const history = tasks.filter(task => task.outcome === 'completed' || task.outcome === 'cancelled')
  const renderTasks = (items: readonly WorkflowTask[]): JSX.Element => <ul>{items.map(task => <li key={task.id}>
      <strong>{task.title}</strong><span>{task.outcome}{task.awaitingSubmission ? ' · Awaiting submitted work' : ''}</span><p>{task.summary}</p>
      {task.question && <p><strong>Question:</strong> {task.question}</p>}
      <details><summary>Task details</summary>
        <p>{task.request || 'The original submitted request is not available for this manually tracked task.'}</p>
        <p>Origin: {task.origin ?? 'human'}{task.createdAt ? ` · Created ${new Date(task.createdAt).toLocaleString()}` : ''}</p>
        {task.completion&&<p>{task.completion.kind==='person'?'Completed by the person':`Verified merged: ${task.completion.repository} #${task.completion.number} · Head ${task.completion.head}`} · {new Date(task.completion.at).toLocaleString()}</p>}
        {task.repositoryPath && <p>Repository: {task.repositoryPath}</p>}
        {task.resources&&<p>Session: {task.resources.session} · Worktree: {task.resources.worktree}{task.resources.checkedAt?` (checked ${new Date(task.resources.checkedAt).toLocaleTimeString()})`:''}</p>}
        {task.worktreePath && <p>Last recorded worktree: {task.worktreePath}{task.branch ? ` · ${task.branch}` : ''}</p>}
        {task.comparisonGroup && <p>Comparison group: {task.comparisonGroup}</p>}
        {task.meetingIds?.length ? <p>Review meetings: {task.meetingIds.join(', ')}</p> : null}
        {task.pullUrl && <button type="button" onClick={() => { void window.copilotDesktop.openExternalUrl(task.pullUrl!).catch(() => setFailure('The PR could not be opened.')) }}>Open PR</button>}
        {task.artifacts?.map((artifact,index) => <p key={index}>{artifact.kind === 'url'
          ? <button type="button" onClick={() => { void window.copilotDesktop.openExternalUrl(artifact.value).catch(() => setFailure('The artifact could not be opened.')) }}>{artifact.label}</button>
          : <span>{artifact.label}: {artifact.value}</span>}</p>)}
        {(task.reports?.length ?? 0) > 0 && <details><summary>Report history · {task.reports!.length}</summary>
          {task.reports!.map((report,index)=><div key={index}><strong>{report.outcome}</strong><p>{report.summary}</p>{report.question&&<p>{report.question}</p>}
            {report.validation.map((check,n)=><p key={n}>{check.name}: {check.status}{check.revision ? ` · ${check.revision}` : ''}</p>)}
          </div>)}
        </details>}
      </details>
      <button type="button" onClick={() => { void window.copilotDesktop.openSessionHistory(task.sessionId).catch(() => setFailure('The linked session could not be opened.')) }}>Open session</button>
      {task.validation.map((check, index) => <span key={index}>{check.name}: {check.status}{check.revision ? ` · ${check.revision}` : ''}</span>)}
      {task.outcome !== 'completed' && task.outcome !== 'cancelled' && <>
        <label>Recorded outcome<select value={task.outcome} onChange={event=>finish(task.id,event.target.value as TaskAction)}>
          {['unknown','working','needs-input','ready','blocked','failed'].map(value=><option key={value} value={value}>{value}</option>)}
        </select></label>
        {(() => {
          const tab=known.find(tab=>tab.lastSessionId===task.sessionId)
          if(!tab)return <p>The session is not open. Open it from History to continue.</p>
          const capability={version:tab.cliVersion,sideChat:Boolean(tab.sideChat),remote:tab.remote,preset:tab.sessionPermissionPreset}
          if(supportsTaskReporting(capability))return null
          return <p>Structured reports are unavailable; set outcomes manually.
            {onRestart&&supportsTaskReporting({...capability,version:installedCliVersion})&&<button type="button" onClick={()=>onRestart(tab.id)}>Resume with task support</button>}
          </p>
        })()}
        <button type="button" onClick={() => finish(task.id, 'completed')}>Mark complete</button>
        <button type="button" title="End task tracking; the CLI session keeps running" onClick={() => finish(task.id, 'cancelled')}>End tracking</button>
        <TaskFollowups taskId={task.id} projectId={task.projectId} createdAt={task.createdAt} projectDefault={defaults.find(value=>value.projectId===task.projectId)} grant={followups.find(g=>g.taskId===task.id)} />
      </>}
      {['completed','cancelled'].includes(task.outcome)&&<button type="button" title="Deletes only this local task record; sessions, files, worktrees and handoff evidence are kept" onClick={()=>finish(task.id,'delete')}>Delete task history</button>}
    </li>)}</ul>
  return <details className="needs-you workflow-tasks"><summary>Tasks · {tasks.length}</summary>
    {(error || failure) && <p role="status">{error || failure}</p>}
    {known.length>0&&<form onSubmit={event=>{
      event.preventDefault();const tab=known.find(tab=>tab.id===(sessionChoice||known[0]?.id));if(tab)chooseTask(tab.id,tasks.some(task=>task.sessionId===tab.lastSessionId&&!['completed','cancelled'].includes(task.outcome)))
    }}>
      <label>Session<select value={sessionChoice||known[0]?.id} onChange={event=>setSessionChoice(event.target.value)}>{known.map(tab=><option key={tab.id} value={tab.id}>{tab.title}</option>)}</select></label>
      <label>Task title<input required maxLength={120} value={title} onChange={event=>setTitle(event.target.value)} /></label>
      <p>Track an existing conversation, or end its current task and start another at an idle, empty prompt. This records an Unknown outcome; it sends no input and grants no tools.</p>
      <button disabled={pending||!title.trim()} type="submit">{tasks.some(task=>task.sessionId===known.find(tab=>tab.id===(sessionChoice||known[0]?.id))?.lastSessionId&&!['completed','cancelled'].includes(task.outcome))?'End current task and track another':'Track this conversation'}</button>
    </form>}
    {active.length > 0 && <><h3>Active · {active.length}</h3>{renderTasks(active)}</>}
    {history.length > 0 && <><h3>History · {history.length}</h3>{renderTasks(history.slice(0, historyLimit))}
      {history.length > historyLimit && <button type="button" onClick={() => setHistoryLimit(limit => limit + 50)}>Show more history</button>}
    </>}
  </details>
}
