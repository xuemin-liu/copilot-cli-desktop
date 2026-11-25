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

export interface CheckpointGateDeps {
  executable: GitExecutable
  runner: GitRunner
  trust: CheckpointTrust
}

export const NEEDS_REVIEW = 'This repository’s Git settings need review in the Git panel first'

/**
 * The repository a session's turns are snapshotted in, or null when it gets no checkpoints: no repository, a
 * repository above the project folder (its changes are not the project's), or a folder that is not the project's.
 * Only the filesystem is read here. Whether Git may run there is `checkpointGate`'s question, asked before every
 * snapshot.
 */
export async function resolveCheckpointTarget(input: CheckpointTargetInput, homeDirectory?: string): Promise<TurnTarget | null> {
  if (!hostPath.isAbsolute(input.cwd) || !isLocalFilesystemPath(input.cwd) || !isLocalFilesystemPath(input.projectPath)) return null
  let found: Awaited<ReturnType<typeof enclosingRepository>>
  let project: string
  try {
    found = await enclosingRepository(input.cwd, homeDirectory)
    project = await realPathNative(input.projectPath)
  } catch { return null }
  if (found.kind !== 'found') return null
  // Outside the project folder only a linked worktree of one of the project's own repositories counts.
  if (!isSameOrInside(found.root, project) && !(await inspectSessionWorktree(found.root, main => isSameOrInside(main, project)))) return null
  return { sessionId: input.sessionId, worktreeRoot: found.root, projectPath: project }
}

/**
 * Why Git must not be run in a target's repository right now, or null when it may. These are the checks the Git panel
 * makes before every command: the `.git` pointers stay on local storage, a worktree still belongs to the project's
 * repository, and the repository's own config names no program the person has not accepted. It runs before each
 * snapshot, because an agent can change any of this during a turn.
 */
export async function checkpointGate(target: Pick<TurnTarget, 'worktreeRoot' | 'projectPath'>, deps: CheckpointGateDeps): Promise<string | null> {
  const { version } = deps.executable
  if (!deps.executable.supported || version.major < MIN_CHECKPOINT_GIT.major || (version.major === MIN_CHECKPOINT_GIT.major && version.minor < MIN_CHECKPOINT_GIT.minor)) {
    return `Checkpoints need Git ${MIN_CHECKPOINT_GIT.major}.${MIN_CHECKPOINT_GIT.minor} or newer (this is ${version.text})`
  }
  const root = target.worktreeRoot
  try {
    const entry = await inspectGitEntry(root)
    if (!entry) return 'The .git entry is gone'
    if (entry.issue) return entry.issue
    if (!isSameOrInside(root, target.projectPath)) {
      const worktree = await inspectSessionWorktree(root, main => isSameOrInside(main, target.projectPath))
      if (!worktree) return 'This folder is no longer a worktree of its repository'
      if (worktree.issue) return worktree.issue
    }
    const scan = await scanRepoConfig(deps.runner, root, undefined, deps.trust)
    if (scan.includes === 'held') return NEEDS_REVIEW
    if (scan.items.length > 0 && !(await deps.trust.isTrusted(root, scan.hash))) return NEEDS_REVIEW
  } catch { return 'This repository’s Git settings could not be read' }
  return null
}
