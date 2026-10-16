export const DEFAULT_WORKTREE_TIMEOUT_MINUTES = 10
export const MAX_WORKTREE_TIMEOUT_MINUTES = 24 * 60

export function isWorktreeTimeoutMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_WORKTREE_TIMEOUT_MINUTES
}

export function normalizeWorktreeTimeoutMinutes(value: unknown): number {
  return isWorktreeTimeoutMinutes(value) ? value : DEFAULT_WORKTREE_TIMEOUT_MINUTES
}
