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
