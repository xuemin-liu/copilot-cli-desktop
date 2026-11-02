import { useState } from 'react'
import type { JSX } from 'react'
import type { WorkflowDelivery } from '../../main/workflow-deliveries.js'

export function DeliveryQueue({ deliveries, error }: { deliveries: readonly WorkflowDelivery[]; error: string | null }): JSX.Element | null {
  const [failure, setFailure] = useState<string | null>(null)
  const pending = deliveries.filter(d => !['answered','cancelled'].includes(d.state))
  if (!pending.length && !error) return null
  const act = (id: string, action: 'retry' | 'discard'): void => {
    setFailure(null)
    void window.copilotDesktop.deliveryAction(id, action).catch(() => setFailure('The handoff changed or could not be updated.'))
  }
  return <details className="needs-you" open><summary>Handoffs · {pending.length}</summary>
    {(error || failure) && <p role="status">{error || failure}</p>}
    <ul>{pending.map(d => <li key={d.id}><strong>{d.source}</strong><span>{d.state}</span>
      <button type="button" onClick={() => { void window.copilotDesktop.openSessionHistory(d.sessionId).catch(() => setFailure('The linked session could not be opened.')) }}>Open session</button>
      {d.state === 'uncertain' && <>
        <p>This input may have already run. Inspect the linked session before choosing to send it again.</p>
        <button type="button" onClick={() => act(d.id, 'retry')}>Send again</button>
        <button type="button" onClick={() => act(d.id, 'discard')}>Discard handoff</button>
      </>}
      {d.state==='queued'&&<button type="button" onClick={()=>act(d.id,'discard')}>Discard queued handoff</button>}
    </li>)}</ul>
  </details>
}
