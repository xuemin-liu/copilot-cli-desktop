import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { renderToStaticMarkup } from 'react-dom/server'
import { WorkflowStore } from './workflow-store.js'
import { WorkflowTasks } from '../renderer/components/WorkflowTasks.js'

test('an older active task remains reachable after fifty newer tasks complete', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-history-'))
  const store = new WorkflowStore(join(dir, 'tasks.sqlite'))
  try {
    store.submitted(randomUUID(), 'project', 'Active task A')
    for (let n = 0; n < 50; n++) {
      const task = store.submitted(randomUUID(), 'project', `Finished task ${n}`)
      store.finish(task.id, 'completed')
    }
    const markup = renderToStaticMarkup(<WorkflowTasks tasks={store.list()} />)
    assert.match(markup, /Active task A/)
    assert.equal((markup.match(/Mark complete/g) ?? []).length, 1)
    assert.equal((markup.match(/>End tracking</g) ?? []).length, 1)
  } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
})
