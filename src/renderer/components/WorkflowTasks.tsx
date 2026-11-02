import { useState } from 'react'
import type { JSX } from 'react'
import type { WorkflowTask } from '../../main/workflow-types.js'

export function WorkflowTasks({ tasks, error }: { tasks: readonly WorkflowTask[]; error?: string | null }): JSX.Element | null {
  const [failure, setFailure] = useState<string | null>(null)
  if (!tasks.length && !error) return null
  const finish = (id: string, action: 'completed' | 'cancelled'): void => {
    setFailure(null)
    void window.copilotDesktop.taskAction(id, action).catch(() => setFailure('The task could not be updated. Try again.'))
  }
  return <details className="needs-you"><summary>Tasks · {tasks.length}</summary>
    {(error || failure) && <p role="status">{error || failure}</p>}
    <ul>{tasks.slice(0, 50).map(task => <li key={task.id}>
      <strong>{task.title}</strong><span>{task.outcome}</span><p>{task.summary}</p>
      {task.validation.map((check, index) => <span key={index}>{check.name}: {check.status}</span>)}
      {task.outcome !== 'completed' && task.outcome !== 'cancelled' && <>
        <button type="button" onClick={() => finish(task.id, 'completed')}>Mark complete</button>
        <button type="button" title="End task tracking; the CLI session keeps running" onClick={() => finish(task.id, 'cancelled')}>End tracking</button>
      </>}
    </li>)}</ul>
  </details>
}
