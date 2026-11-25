import { enclosingRepository, inspectGitEntry, inspectSessionWorktree } from './git-discovery.js'
import type { GitExecutable, GitRunner } from './git-runner.js'
import { scanRepoConfig, type IncludeApprovals } from './git-trust.js'
import { hostPath, isSameOrInside } from './host-path.js'
import { isLocalFilesystemPath } from './external-targets.js'
import { realPathNative } from './real-path.js'
import type { TurnTarget } from './turn-checkpoints.js'

/** The oldest Git with `GIT_CONFIG_GLOBAL`, which keeps the person's own config out of the checkpoint store. */
export const MIN_CHECKPOINT_GIT = { major: 2, minor: 32 } as const

export interface CheckpointTrust extends IncludeApprovals {
  isTrusted(root: string, hash: string): Promise<boolean>
}

export interface CheckpointTargetInput {
  sessionId: string
  /** The folder the session reports working in. It is data the CLI wrote. */
  cwd: string
  /** The project folder the session's tab belongs to. */
  projectPath: string
}

export interface CheckpointTargetDeps {
  executable: GitExecutable
  runner: GitRunner
  trust: CheckpointTrust
  homeDirectory?: string
}

export const NEEDS_REVIEW = 'This repository’s Git settings need review in the Git panel first'

/**
 * The repository a session's turns are snapshotted in, or null when it gets no checkpoints: no repository, a
 * repository above the project folder (its changes are not the project's), or a folder that is not the project's.
 * The same checks the Git panel makes before it runs Git are made here; a repository that fails one is returned with
 * the reason, so the turn can say why it has no snapshot.
 */
export async function resolveCheckpointTarget(input: CheckpointTargetInput, deps: CheckpointTargetDeps): Promise<TurnTarget | null> {
  if (!hostPath.isAbsolute(input.cwd) || !isLocalFilesystemPath(input.cwd) || !isLocalFilesystemPath(input.projectPath)) return null
  let found: Awaited<ReturnType<typeof enclosingRepository>>
  let project: string
  try {
    found = await enclosingRepository(input.cwd, deps.homeDirectory)
    project = await realPathNative(input.projectPath)
  } catch { return null }
  if (found.kind !== 'found') return null
  const root = found.root
  let issue = found.issue
  if (!isSameOrInside(root, project)) {
    // Outside the project folder only a linked worktree of one of the project's own repositories counts.
    const worktree = await inspectSessionWorktree(root, main => isSameOrInside(main, project))
    if (!worktree) return null
    issue ??= worktree.issue
  }
  const target = (refused: string | null): TurnTarget => ({ sessionId: input.sessionId, worktreeRoot: root, refused })
  if (issue) return target(issue)
  const { version } = deps.executable
  if (!deps.executable.supported || version.major < MIN_CHECKPOINT_GIT.major || (version.major === MIN_CHECKPOINT_GIT.major && version.minor < MIN_CHECKPOINT_GIT.minor)) {
    return target(`Checkpoints need Git ${MIN_CHECKPOINT_GIT.major}.${MIN_CHECKPOINT_GIT.minor} or newer (this is ${version.text})`)
  }
  try {
    // Checked again right before Git runs: the pointers can change while the session is open.
    const entry = await inspectGitEntry(root)
    if (!entry) return null
    if (entry.issue) return target(entry.issue)
    const scan = await scanRepoConfig(deps.runner, root, undefined, deps.trust)
    if (scan.includes === 'held') return target(NEEDS_REVIEW)
    if (scan.items.length > 0 && !(await deps.trust.isTrusted(root, scan.hash))) return target(NEEDS_REVIEW)
  } catch { return target('This repository’s Git settings could not be read') }
  return target(null)
}
