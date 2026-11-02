import { useState } from 'react'
import type { JSX } from 'react'
import type { WorkflowTask } from '../../main/workflow-types.js'

export function WorkflowTasks({ tasks, error }: { tasks: readonly WorkflowTask[]; error?: string | null }): JSX.Element | null {
  const [failure, setFailure] = useState<string | null>(null)
  const [historyLimit, setHistoryLimit] = useState(50)
  if (!tasks.length && !error) return null
  const finish = (id: string, action: 'completed' | 'cancelled'): void => {
    setFailure(null)
    void window.copilotDesktop.taskAction(id, action).catch(() => setFailure('The task could not be updated. Try again.'))
  }
  const active = tasks.filter(task => task.outcome !== 'completed' && task.outcome !== 'cancelled')
  const history = tasks.filter(task => task.outcome === 'completed' || task.outcome === 'cancelled')
  const renderTasks = (items: readonly WorkflowTask[]): JSX.Element => <ul>{items.map(task => <li key={task.id}>
      <strong>{task.title}</strong><span>{task.outcome}</span><p>{task.summary}</p>
      <button type="button" onClick={() => { void window.copilotDesktop.openSessionHistory(task.sessionId).catch(() => setFailure('The linked session could not be opened.')) }}>Open session</button>
      {task.validation.map((check, index) => <span key={index}>{check.name}: {check.status}</span>)}
      {task.outcome !== 'completed' && task.outcome !== 'cancelled' && <>
        <button type="button" onClick={() => finish(task.id, 'completed')}>Mark complete</button>
        <button type="button" title="End task tracking; the CLI session keeps running" onClick={() => finish(task.id, 'cancelled')}>End tracking</button>
      </>}
    </li>)}</ul>
  return <details className="needs-you"><summary>Tasks · {tasks.length}</summary>
    {(error || failure) && <p role="status">{error || failure}</p>}
    {active.length > 0 && <><h3>Active · {active.length}</h3>{renderTasks(active)}</>}
    {history.length > 0 && <><h3>History · {history.length}</h3>{renderTasks(history.slice(0, historyLimit))}
      {history.length > historyLimit && <button type="button" onClick={() => setHistoryLimit(limit => limit + 50)}>Show more history</button>}
    </>}
  </details>
}
