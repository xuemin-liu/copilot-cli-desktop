import { useState } from 'react'
import type { JSX } from 'react'
import type { WorkflowTask,TaskArtifact } from '../../main/workflow-types.js'
import type { FollowupGrant } from '../../main/workflow-followups.js'
import { TaskFollowups } from './WorkflowFollowups.js'

export function WorkflowTasks({ tasks, error,followups=[] }: { tasks: readonly WorkflowTask[]; error?: string | null;followups?:readonly FollowupGrant[] }): JSX.Element | null {
  const [failure, setFailure] = useState<string | null>(null)
  const [historyLimit, setHistoryLimit] = useState(50)
  if (!tasks.length && !error) return null
  const finish = (id: string, action: 'completed' | 'cancelled'): void => {
    setFailure(null)
    void window.copilotDesktop.taskAction(id, action).catch(() => setFailure('The task could not be updated. Try again.'))
  }
  const active = tasks.filter(task => task.outcome !== 'completed' && task.outcome !== 'cancelled')
  const history = tasks.filter(task => task.outcome === 'completed' || task.outcome === 'cancelled')
  const renderArtifacts=(artifacts:readonly TaskArtifact[]=[]):JSX.Element[]=>artifacts.map((artifact,index)=><p key={index}>{artifact.kind==='url'
    ?<button type="button" title={artifact.value} onClick={()=>{void window.copilotDesktop.openExternalUrl(artifact.value).catch(()=>setFailure('The artifact could not be opened.'))}}>{artifact.label} · {artifact.value}</button>
    :<span>{artifact.label}: {artifact.value}</span>}</p>)
  const renderTasks = (items: readonly WorkflowTask[]): JSX.Element => <ul>{items.map(task => <li key={task.id}>
      <strong>{task.title}</strong><span>{task.outcome}</span><p>{task.summary}</p>
      {task.question && <p><strong>Question:</strong> {task.question}</p>}
      <details><summary>Task details</summary>
        <p>{task.request}</p>
        <p>Origin: {task.origin ?? 'human'}{task.createdAt ? ` · Created ${new Date(task.createdAt).toLocaleString()}` : ''}</p>
        {task.repositoryPath && <p>Repository: {task.repositoryPath}</p>}
        {task.worktreePath && <p>Worktree: {task.worktreePath}{task.branch ? ` · ${task.branch}` : ''}</p>}
        {task.comparisonGroup && <p>Comparison group: {task.comparisonGroup}</p>}
        {task.meetingIds?.length ? <p>Review meetings: {task.meetingIds.join(', ')}</p> : null}
        {task.pullUrl && <button type="button" onClick={() => { void window.copilotDesktop.openExternalUrl(task.pullUrl!).catch(() => setFailure('The PR could not be opened.')) }}>Open PR</button>}
        {renderArtifacts(task.artifacts)}
        {(task.reports?.length ?? 0) > 0 && <details><summary>Report history · {task.reports!.length}</summary>
          {task.reports!.map((report,index)=><div key={index}><strong>{report.outcome}</strong><p>{report.summary}</p>{report.question&&<p>{report.question}</p>}
            {renderArtifacts(report.artifacts)}
            {report.validation.map((check,n)=><p key={n}>{check.name}: {check.status}{check.revision ? ` · ${check.revision}` : ''}</p>)}
          </div>)}
        </details>}
      </details>
      <button type="button" onClick={() => { void window.copilotDesktop.openSessionHistory(task.sessionId).catch(() => setFailure('The linked session could not be opened.')) }}>Open session</button>
      {task.validation.map((check, index) => <span key={index}>{check.name}: {check.status}{check.revision ? ` · ${check.revision}` : ''}</span>)}
      {task.outcome !== 'completed' && task.outcome !== 'cancelled' && <>
        <button type="button" onClick={() => finish(task.id, 'completed')}>Mark complete</button>
        <button type="button" title="End task tracking; the CLI session keeps running" onClick={() => finish(task.id, 'cancelled')}>End tracking</button>
        <TaskFollowups taskId={task.id} grant={followups.find(g=>g.taskId===task.id)} />
      </>}
    </li>)}</ul>
  return <details className="needs-you workflow-tasks"><summary>Tasks · {tasks.length}</summary>
    {(error || failure) && <p role="status">{error || failure}</p>}
    {active.length > 0 && <><h3>Active · {active.length}</h3>{renderTasks(active)}</>}
    {history.length > 0 && <><h3>History · {history.length}</h3>{renderTasks(history.slice(0, historyLimit))}
      {history.length > historyLimit && <button type="button" onClick={() => setHistoryLimit(limit => limit + 50)}>Show more history</button>}
    </>}
  </details>
}
