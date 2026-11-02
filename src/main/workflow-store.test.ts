import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowStore, WorkflowTaskLimitError } from './workflow-store.js'
import { DatabaseSync } from 'node:sqlite'
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
    assert.notEqual(store.submitted(session, 'project', 'Next task'.repeat(20_000)).id, task.id)
    store.close()
    store = new WorkflowStore(path)
    assert.equal(store.list().length, 2)
    const bytes = await readFile(path)
    assert.equal(bytes.includes(Buffer.from('fixture-secret')), false)
    assert.equal(bytes.includes(Buffer.from('fixture-private')), false)
    const writer = new DatabaseSync(path)
    try { writer.prepare('UPDATE tasks SET value=? WHERE active=1').run('null') } finally { writer.close() }
    assert.throws(() => store.list(), /Invalid stored/)
    assert.throws(() => store.active(session), /Invalid stored/)
  } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
})

test('retention prunes terminal history and a full active set leaves reporting and completion usable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-retention-'))
  const history = new WorkflowStore(join(dir,'history.sqlite'))
  const active = new WorkflowStore(join(dir,'active.sqlite'))
  try {
    const retained = history.submitted('retained','project','Keep this active')
    for (let n=0;n<999;n++) {
      const task = history.submitted('history','project',`Finished ${n}`)
      history.finish(task.id,n%2 ? 'completed' : 'cancelled')
    }
    assert.equal(history.list().length,1000)
    history.submitted('new','project','New work')
    assert.ok(history.list().length<=1000)
    assert.equal(history.active('retained')?.id,retained.id)
    assert.ok(!history.list().some(task => task.request === 'Finished 0'))
    for(let n=0;n<1000;n++) active.submitted(`session-${n}`,'project',`Active ${n}`)
    assert.throws(() => active.submitted('overflow','project','New work'),WorkflowTaskLimitError)
    const task=active.active('session-0')!
    active.report(task.sessionId,{taskId:task.id,assignmentId:task.assignmentId,scopeRevision:1,outcome:'ready',summary:'Ready'})
    assert.equal(active.active(task.sessionId)?.outcome,'ready')
    active.finish(task.id,'completed')
    assert.ok(active.submitted('overflow','project','Retry after freeing space'))
    assert.equal(active.list().length,1000)
  } finally { history.close();active.close();await rm(dir,{recursive:true,force:true}) }
})
