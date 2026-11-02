import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowStore } from './workflow-store.js'
const session = '11111111-1111-4111-8111-111111111111'
test('tasks persist, reports bind to assignment, and only manual completion ends a task', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-test-'))
  const path = join(dir, 'workflows.sqlite')
  let store = new WorkflowStore(path)
  try {
    const task = store.submitted(session, 'project', 'Fix token=fixture-secret')
    assert.equal(task.request, 'Fix token=[REDACTED]')
    const report = { taskId: task.id, assignmentId: task.assignmentId, scopeRevision: 1, outcome: 'ready', summary: 'pass\u200bword=fixture-private', validation: [{ name: 'Checks token=fixture-check', status: 'not-run' }] }
    assert.throws(() => store.report(session, { ...report, assignmentId: 'foreign' }), /Stale/)
    assert.throws(() => store.report(session, { ...report, outcome: 'completed' }), /Invalid/)
    assert.throws(() => store.report(session, { ...report, permissions: 'all' }), /Unknown/)
    assert.equal(store.report(session, report).summary, 'password=[REDACTED]')
    assert.equal(store.active(session)?.validation[0]?.name, 'Checks token=[REDACTED]')
    store.close()
    store = new WorkflowStore(path)
    assert.equal(store.active(session)?.outcome, 'ready')
    assert.equal(store.submitted(session, 'project', 'Continue').id, task.id)
    assert.equal(store.active(session)?.outcome, 'working')
    store.finish(task.id, 'completed')
    assert.equal(store.active(session), null)
    assert.notEqual(store.submitted(session, 'project', 'Next task').id, task.id)
    store.close()
    store = new WorkflowStore(path)
    assert.equal(store.list().length, 2)
    const bytes = await readFile(path)
    assert.equal(bytes.includes(Buffer.from('fixture-secret')), false)
    assert.equal(bytes.includes(Buffer.from('fixture-private')), false)
  } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
})
