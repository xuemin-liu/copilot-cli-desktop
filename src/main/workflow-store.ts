import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { redactDiagnosticText } from './desktop-diagnostics.js'
import { isValidSessionId } from './session-id.js'
import type { WorkflowTask } from './workflow-types.js'

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length > 16_000) throw new Error('Invalid workflow text')
  return redactDiagnosticText(value.replace(/[\p{Cc}\p{Cf}]/gu, '')).slice(0, limit)
}
/** Workflow-owned text is sanitized before it reaches SQLite. No caller-supplied paths or SQL. */
export class WorkflowStore {
  private db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    try {
      const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
      if (version.user_version !== 0 && version.user_version !== 1) throw new Error('Unsupported workflow schema')
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, session TEXT NOT NULL, active INTEGER NOT NULL, value TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS active_task ON tasks(session) WHERE active=1;
        PRAGMA user_version=1;`)
    } catch (error) { this.db.close(); throw error }
  }
  close(): void { this.db.close() }
  list(): WorkflowTask[] {
    return (this.db.prepare('SELECT value FROM tasks ORDER BY rowid DESC LIMIT 1000').all() as {value: string}[]).map(row => JSON.parse(row.value) as WorkflowTask)
  }
  active(sessionId: string): WorkflowTask | null {
    const row = this.db.prepare('SELECT value FROM tasks WHERE session=? AND active=1').get(sessionId) as { value: string } | undefined
    return row ? JSON.parse(row.value) as WorkflowTask : null
  }
  submitted(sessionId: string, projectId: string, request: string): WorkflowTask {
    if (!isValidSessionId(sessionId)) throw new Error('Invalid session')
    const current = this.active(sessionId)
    if (current) { const next: WorkflowTask = { ...current, outcome: 'working', updatedAt: Date.now() }; this.save(next); return next }
    if ((this.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n >= 1000) throw new Error('Workflow task limit reached')
    const clean = text(request, 4000)
    const task: WorkflowTask = { id: randomUUID(), assignmentId: randomUUID(), sessionId, projectId: text(projectId, 128),
      title: clean.slice(0, 120) || 'Task', request: clean, scopeRevision: 1, outcome: 'working', summary: '', validation: [], updatedAt: Date.now() }
    this.save(task)
    return task
  }
  report(sessionId: string, value: unknown): WorkflowTask {
    const current = this.active(sessionId)
    if (!current || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('No matching active task')
    const report = value as Record<string, unknown>
    if (report.taskId !== current.id || report.assignmentId !== current.assignmentId || report.scopeRevision !== current.scopeRevision)
      throw new Error('Stale or foreign task report')
    const allowed = ['needs-input', 'ready', 'blocked', 'failed', 'working'] as const
    const outcome = allowed.find(kind => kind === report.outcome)
    if (!outcome) throw new Error('Invalid task outcome')
    if (Object.keys(report).some(key => !['taskId','assignmentId','scopeRevision','outcome','summary','validation'].includes(key))) throw new Error('Unknown task report field')
    const checks = report.validation ?? []
    if (!Array.isArray(checks) || checks.length > 20) throw new Error('Invalid validation list')
    const validation: WorkflowTask['validation'] = checks.map(check => {
      if (!check || typeof check !== 'object' || Array.isArray(check) || Object.keys(check).some(k => !['name','status'].includes(k))) throw new Error('Invalid validation entry')
      if (!['passed','failed','not-run'].includes(check.status)) throw new Error('Invalid validation status')
      return { name: text(check.name, 120), status: check.status }
    })
    const next: WorkflowTask = { ...current, outcome, summary: text(report.summary, 4000), validation, updatedAt: Date.now() }
    this.save(next)
    return next
  }
  finish(id: string, outcome: 'completed' | 'cancelled'): void {
    const row = this.db.prepare('SELECT value FROM tasks WHERE id=?').get(id) as {value: string} | undefined
    if (!row) throw new Error('Unknown task')
    const task = JSON.parse(row.value) as WorkflowTask
    this.save({ ...task, outcome, updatedAt: Date.now() })
  }
  private save(task: WorkflowTask): void {
    this.db.prepare('INSERT INTO tasks(id,session,active,value) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET active=excluded.active,value=excluded.value')
      .run(task.id, task.sessionId, Number(task.outcome !== 'completed' && task.outcome !== 'cancelled'), JSON.stringify(task))
  }
}
