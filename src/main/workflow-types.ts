export type TaskOutcome = 'unknown' | 'working' | 'needs-input' | 'ready' | 'blocked' | 'failed' | 'completed' | 'cancelled'
export interface WorkflowTask {
  id: string; sessionId: string; projectId: string; title: string; request: string; assignmentId: string;
  scopeRevision: number; outcome: TaskOutcome; summary: string; updatedAt: number;
  validation: { name: string; status: 'passed' | 'failed' | 'not-run' }[]
}
