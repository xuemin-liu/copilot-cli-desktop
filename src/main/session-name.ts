// No imports: the renderer bundles this file to preview a session's worktree name, so it must not reach Node modules.

export const MAX_SESSION_TITLE_CHARS = 120
const MAX_SLUG_CHARS = 24

/** The name typed for a new session; empty means the default, the project's name. */
export function newSessionTitle(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > 1000) throw new Error('Invalid session title')
  return value.trim().slice(0, MAX_SESSION_TITLE_CHARS) || null
}

/** `desktop-<title slug>`, to which a worktree launch adds `-<6 hex>`. Only characters git accepts in a branch name, bounded. */
export function worktreeNamePrefix(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_SLUG_CHARS).replace(/-+$/, '')
  return `desktop-${slug || 'session'}`
}

/** Choices made for one new session in the new-session dialog, over the project's defaults. */
export interface NewSessionOptions {
  /** Start in its own Git worktree; absent means the project's setting. */
  worktree?: boolean
  /** Start in this existing linked worktree of the project's repository instead; main checks it is one. */
  worktreePath?: string
  /** Use the DevTools settings and Local Overrides every session shares; absent means the Settings default. */
  sharedOverrides?: boolean
}

export function newSessionOptions(value: unknown): NewSessionOptions {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid session options')
  const { worktree, worktreePath, sharedOverrides } = value as Record<string, unknown>
  if (worktree !== undefined && typeof worktree !== 'boolean') throw new Error('Invalid session options')
  if (worktreePath !== undefined && (typeof worktreePath !== 'string' || worktreePath.length < 1 || worktreePath.length > 4_096
    || [...worktreePath].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127))) throw new Error('Invalid session options')
  // A session starts in a new worktree or an existing one, not both.
  if (worktreePath !== undefined && worktree === true) throw new Error('Invalid session options')
  if (sharedOverrides !== undefined && typeof sharedOverrides !== 'boolean') throw new Error('Invalid session options')
  return {
    ...(worktree === undefined ? {} : { worktree }),
    ...(worktreePath === undefined ? {} : { worktreePath }),
    ...(sharedOverrides === undefined ? {} : { sharedOverrides }),
  }
}
