import type { JSX } from 'react'
import type { ResolvePullSituation } from '../../main/git-prompt.js'

/** Whether `folder` is `base` or inside it, ignoring case and separators as Windows does. */
export function folderWithin(folder: string, base: string): boolean {
  const normal = (path: string): string => path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const inner = normal(folder)
  const outer = normal(base)
  return outer !== '' && (inner === outer || inner.startsWith(`${outer}\\`))
}

export interface ResolveTarget {
  title: string
  /** Why this session can never take the task (read-only, a side chat, not running), or null. */
  taskBlocker?: string | null
}

/** Why Resolve with Copilot is unavailable, or null when it is available. */
export function resolveBlocker(target: ResolveTarget | null, gitRunning: boolean, resolving: boolean): string | null {
  if (!target) return 'Open a session in this window first.'
  if (target.taskBlocker) return target.taskBlocker
  if (resolving) return `“${target.title}” is already working on this pull.`
  if (gitRunning) return 'Wait for the running Git operation to finish.'
  return null
}

export interface GitResolveBarProps {
  situation: ResolvePullSituation
  branch: string
  upstream: string | null
  /** The repository's folder, named in the task. */
  folder: string
  target: ResolveTarget | null
  /** The repository is outside the session's own folder, so Copilot may ask for permission to work there. */
  outside: boolean
  blocker: string | null
  onResolve(): void
}

const lead = (situation: ResolvePullSituation, branch: string, upstream: string): string =>
  situation === 'conflicts' ? 'Copilot can resolve these conflicts and finish the merge.'
    : situation === 'local-changes' ? `Copilot can look at the changes in the way, ask you what to do with them, then merge ${upstream} into ${branch} and resolve any conflicts.`
      : `Copilot can merge ${upstream} into ${branch} and resolve any conflicts, as it would if you asked in the terminal.`

/** Offered after a pull Copilot can finish (diverged, local changes in the way) and while a merge is stopped on conflicts. */
export function GitResolveBar(props: GitResolveBarProps): JSX.Element {
  const { target, blocker } = props
  const title = blocker ?? `Ask “${target?.title ?? ''}” to do it in ${props.folder}`
    + `${props.outside ? ', outside its own folder (it may ask for permission to work there)' : ''}. It merges and commits, but never pushes; review what it did before you push.`
  return (
    <div className="git-resolve" role="group" aria-label="Resolve with Copilot">
      <p>{lead(props.situation, props.branch, props.upstream ?? 'the upstream')}</p>
      <button type="button" className="primary-button" disabled={blocker !== null} title={title} onClick={props.onResolve}>Resolve with Copilot</button>
      {blocker && <p className="git-note">{blocker}</p>}
      {!blocker && props.outside && <p className="git-note">The repository is outside the session&rsquo;s folder, so Copilot may ask for permission to work there.</p>}
    </div>
  )
}
