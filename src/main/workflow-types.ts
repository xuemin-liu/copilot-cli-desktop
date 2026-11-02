export type TaskOutcome = 'unknown' | 'working' | 'needs-input' | 'ready' | 'blocked' | 'failed' | 'completed' | 'cancelled'
export interface TaskArtifact { label: string; kind: 'url' | 'path'; value: string }
export interface TaskValidation { name: string; status: 'passed' | 'failed' | 'not-run'; revision?: string }
export interface TaskReport {
  version?: 1;
  outcome: TaskOutcome; summary: string; question: string; artifacts: TaskArtifact[];
  validation: TaskValidation[]; reportedAt: number
}
/** Host observations only; reporting workers cannot change task ownership or these links. */
export interface TaskContext {
  origin?: 'human' | 'adopted' | 'automation'; comparisonGroup?: string;
  repositoryPath?: string; worktreePath?: string; branch?: string; meetingId?: string; pullUrl?: string
}
export interface WorkflowTask {
  id: string; sessionId: string; projectId: string; title: string; request: string; assignmentId: string;
  scopeRevision: number; outcome: TaskOutcome; summary: string; updatedAt: number;
  validation: TaskValidation[]
  createdAt?: number; origin?: NonNullable<TaskContext['origin']>; comparisonGroup?: string;
  repositoryPath?: string; worktreePath?: string; branch?: string; pullUrl?: string;
  meetingIds?: string[]; question?: string; artifacts?: TaskArtifact[]; reports?: TaskReport[]
}
