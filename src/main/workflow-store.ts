import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { redactDiagnosticText } from './desktop-diagnostics.js'
import { isValidSessionId } from './session-id.js'
import type { WorkflowTask, TaskContext, TaskArtifact, TaskValidation, TaskReport } from './workflow-types.js'

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length > 16_000) throw new Error('Invalid workflow text')
  return redactDiagnosticText(value.replace(/[\p{Cc}\p{Cf}]/gu, '')).slice(0, limit)
}
function validations(value: unknown): TaskValidation[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Invalid validation list')
  return value.map(check => {
    if (!check || typeof check !== 'object' || Array.isArray(check) || Object.keys(check).some(k => !['name','status','revision'].includes(k))
      || !['passed','failed','not-run'].includes(check.status)) throw new Error('Invalid validation entry')
    return {name:text(check.name,120),status:check.status,...(check.revision===undefined?{}:{revision:text(check.revision,120)})}
  })
}
function artifacts(value: unknown): TaskArtifact[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Invalid artifacts')
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(k=>!['label','kind','value'].includes(k))
      || !['url','path'].includes(item.kind)) throw new Error('Invalid artifact')
    const result:TaskArtifact={label:text(item.label,120),kind:item.kind,value:text(item.value,2048)}
    if (result.kind==='url') {
      let url:URL;try{url=new URL(result.value)}catch{throw new Error('Invalid artifact URL')}
      if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid artifact URL')
    }
    return result
  })
}
function context(value:TaskContext):Partial<WorkflowTask> {
  const result:Partial<WorkflowTask>={}
  if(value.origin!==undefined){if(!['human','adopted','automation'].includes(value.origin))throw new Error('Invalid task origin');result.origin=value.origin}
  for(const key of ['comparisonGroup','repositoryPath','worktreePath','branch','pullUrl'] as const)if(value[key]!==undefined)result[key]=text(value[key],key==='branch'?256:2048)
  if(value.meetingId!==undefined)result.meetingIds=[text(value.meetingId,128)]
  return result
}
function decode(value: string): WorkflowTask {
  const task = JSON.parse(value) as WorkflowTask | null
  if (!task || typeof task !== 'object' || !isValidSessionId(task.id) || !isValidSessionId(task.sessionId)
    || !isValidSessionId(task.assignmentId) || task.scopeRevision !== 1 || !Number.isFinite(task.updatedAt)
    || !['unknown','working','needs-input','ready','blocked','failed','completed','cancelled'].includes(task.outcome)
    || !Array.isArray(task.validation) || task.validation.length > 20) throw new Error('Invalid stored workflow task')
  for (const check of task.validation) {
    if (!check || !['passed','failed','not-run'].includes(check.status) || text(check.name, 120) !== check.name) throw new Error('Invalid stored validation')
  }
  if(JSON.stringify(validations(task.validation))!==JSON.stringify(task.validation))throw new Error('Invalid stored validation')
  for (const [key, limit] of [['title',120],['request',4000],['summary',4000],['projectId',128]] as const) {
    if (text(task[key], limit) !== task[key]) throw new Error('Invalid stored workflow text')
  }
  if(task.createdAt!==undefined&&!Number.isFinite(task.createdAt))throw new Error('Invalid task creation time')
  const extra=context(task)
  for(const [key,entry] of Object.entries(extra))if(JSON.stringify(task[key as keyof WorkflowTask])!==JSON.stringify(entry))throw new Error('Invalid stored task context')
  if(task.question!==undefined&&text(task.question,2000)!==task.question)throw new Error('Invalid stored question')
  if(task.artifacts!==undefined&&JSON.stringify(artifacts(task.artifacts))!==JSON.stringify(task.artifacts))throw new Error('Invalid stored artifacts')
  if(task.meetingIds!==undefined&&(!Array.isArray(task.meetingIds)||task.meetingIds.length>50||task.meetingIds.some(id=>text(id,128)!==id)))throw new Error('Invalid stored meetings')
  if(task.reports!==undefined){
    if(!Array.isArray(task.reports)||task.reports.length>20)throw new Error('Invalid stored reports')
    for(const report of task.reports)if(!report||(report.version!==undefined&&report.version!==1)||!['working','needs-input','ready','blocked','failed'].includes(report.outcome)||!Number.isFinite(report.reportedAt)
      ||text(report.summary,4000)!==report.summary||text(report.question,2000)!==report.question
      ||JSON.stringify(artifacts(report.artifacts))!==JSON.stringify(report.artifacts)||JSON.stringify(validations(report.validation))!==JSON.stringify(report.validation))throw new Error('Invalid stored report')
  }
  return {...task,createdAt:task.createdAt??task.updatedAt,origin:task.origin??'human',meetingIds:task.meetingIds??[],question:task.question??'',artifacts:task.artifacts??[],reports:task.reports??[]}
}
export class WorkflowTaskLimitError extends Error {}

/** Workflow-owned text is sanitized before it reaches SQLite. No caller-supplied paths or SQL. */
export class WorkflowStore {
  private db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    try {
      const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
      if (version.user_version !== 0 && version.user_version !== 1 && version.user_version !== 2) throw new Error('Unsupported workflow schema')
      if(version.user_version===1&&!existsSync(path+'.pre-v2.sqlite'))this.db.prepare('VACUUM INTO ?').run(path+'.pre-v2.sqlite')
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, session TEXT NOT NULL, active INTEGER NOT NULL, value TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS active_task ON tasks(session) WHERE active=1;
        PRAGMA user_version=2;`)
    } catch (error) { this.db.close(); throw error }
  }
  close(): void { this.db.close() }
  list(): WorkflowTask[] {
    return (this.db.prepare('SELECT value FROM tasks ORDER BY rowid DESC LIMIT 1000').all() as {value: string}[]).map(row => decode(row.value))
  }
  active(sessionId: string): WorkflowTask | null {
    const row = this.db.prepare('SELECT value FROM tasks WHERE session=? AND active=1').get(sessionId) as { value: string } | undefined
    return row ? decode(row.value) : null
  }
  submitted(sessionId: string, projectId: string, request: string, metadata:TaskContext = {}): WorkflowTask {
    if (!isValidSessionId(sessionId)) throw new Error('Invalid session')
    const current = this.active(sessionId)
    if (current) { const next: WorkflowTask = { ...current, ...context(metadata), outcome: 'working', question:'', updatedAt: Date.now() }; this.save(next); return next }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if ((this.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n >= 1000) {
        this.db.exec('DELETE FROM tasks WHERE id IN (SELECT id FROM tasks WHERE active=0 ORDER BY rowid LIMIT 100)')
        if ((this.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n >= 1000) throw new WorkflowTaskLimitError('Finish or end an active task before starting another tracked task.')
      }
      const clean = text(request.slice(0, 16_000), 4000)
      const task: WorkflowTask = { id: randomUUID(), assignmentId: randomUUID(), sessionId, projectId: text(projectId, 128),
        title: clean.slice(0, 120) || 'Task', request: clean, scopeRevision: 1, outcome: 'working', summary: '', validation: [], updatedAt: Date.now(),createdAt:Date.now(),origin:'human',meetingIds:[],question:'',artifacts:[],reports:[],...context(metadata) }
      this.save(task)
      this.db.exec('COMMIT')
      return task
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  report(sessionId: string, value: unknown): WorkflowTask {
    const current = this.active(sessionId)
    if (!current || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('No matching active task')
    const report = value as Record<string, unknown>
    if(report.version!==undefined&&report.version!==1)throw new Error('Unsupported task report version')
    if (report.taskId !== current.id || report.assignmentId !== current.assignmentId || report.scopeRevision !== current.scopeRevision)
      throw new Error('Stale or foreign task report')
    const allowed = ['needs-input', 'ready', 'blocked', 'failed', 'working'] as const
    const outcome = allowed.find(kind => kind === report.outcome)
    if (!outcome) throw new Error('Invalid task outcome')
    if (Object.keys(report).some(key => !['version','taskId','assignmentId','scopeRevision','outcome','summary','question','artifacts','validation'].includes(key))) throw new Error('Unknown task report field')
    const validation=validations(report.validation??[]), references=artifacts(report.artifacts??[])
    const question=text(report.question??'',2000), summary=text(report.summary,4000)
    const entry:TaskReport={version:1,outcome,summary,question,artifacts:references,validation,reportedAt:Date.now()}
    const next: WorkflowTask = { ...current, outcome, summary,question,artifacts:references,validation,
      reports:[...(current.reports??[]),entry].slice(-20), updatedAt: Date.now() }
    this.save(next)
    return next
  }
  /** Host-provided context never changes the assignment or scope. Missing resources remain recorded. */
  link(sessionId:string,metadata:TaskContext):void {
    const task=this.active(sessionId);if(!task)return
    const next=context(metadata),meetingIds=metadata.meetingId?[...new Set([...(task.meetingIds??[]),text(metadata.meetingId,128)])].slice(-50):task.meetingIds
    this.save({...task,...next,...(meetingIds?{meetingIds}:{}),updatedAt:Date.now()})
  }
  finish(id: string, outcome: 'completed' | 'cancelled'): void {
    const row = this.db.prepare('SELECT value FROM tasks WHERE id=?').get(id) as {value: string} | undefined
    if (!row) throw new Error('Unknown task')
    const task = decode(row.value)
    this.save({ ...task, outcome, updatedAt: Date.now() })
  }
  /** An integration without a report helper can expose turn completion without claiming a successful outcome. */
  unreportedTurn(sessionId:string):void {
    const task=this.active(sessionId)
    if(task?.outcome==='working')this.save({...task,outcome:'unknown',summary:'The investigation turn ended. Review its session; no structured outcome report is available.',updatedAt:Date.now()})
  }
  private save(task: WorkflowTask): void {
    this.db.prepare('INSERT INTO tasks(id,session,active,value) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET active=excluded.active,value=excluded.value')
      .run(task.id, task.sessionId, Number(task.outcome !== 'completed' && task.outcome !== 'cancelled'), JSON.stringify(task))
  }
}
