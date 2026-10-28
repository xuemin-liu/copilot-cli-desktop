import { lstat, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { isLocalFilesystemPath } from './external-targets.js'
import { inspectGitEntry } from './git-discovery.js'
import { ceilingDirectories } from './git-env.js'
import type { GitRunner, GitRunResult } from './git-runner.js'
import { scanRepoConfig, type GitTrustStore } from './git-trust.js'

/**
 * The uncommitted changes of a folder the person picked, as a patch, for an outside agent hosting a meeting
 * (docs/meeting-guests-plan.md, phase 3). The same limits as the host helper's `-Changes`: tracked changes against HEAD,
 * then up to 100 new files of at most 512 KB each, while the patch is under 5 MB; anything left out is named.
 *
 * The folder is the outside agent's project, which it can change, so Git runs as everywhere else in the desktop: through the
 * `GitRunner` (the resolved executable, the hardened environment and `-c` settings, no repository hooks), and only after
 * the Git panel's checks, in its order: the folder must be local, its `.git` entry is found and inspected on the filesystem
 * before any Git process starts (a `.git` file can point at a network share), and a repository whose own config names a
 * program (a clean filter runs even on `diff`) is refused until the person has accepted that config in the Git panel.
 */

const MAX_NEW_FILES = 100
const MAX_NEW_FILE_BYTES = 512 * 1024
const MAX_PATCH_CHARS = 5_000_000
const GIT_TIMEOUT_MS = 30_000

const DIFF = ['-c', 'diff.external=', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/']

export interface FolderChangesDeps {
  runner: GitRunner
  /** The Git panel's trust store: what the person accepted there is accepted here. */
  trust: GitTrustStore
  /** Largest output one Git command may give; tests make it small. */
  maxOutputBytes?: number
}

export class FolderChangesError extends Error {
  override name = 'FolderChangesError'
}

/**
 * The repository the folder belongs to, found on the filesystem as the Git panel's discovery does: the folder itself or its
 * nearest ancestor with a `.git` entry. Nothing here starts Git, so the entry is inspected before any program reads it.
 */
async function repositoryRoot(folder: string): Promise<string | null> {
  for (let current = resolve(folder); ; current = dirname(current)) {
    if (await lstat(join(current, '.git')).then(() => true, () => false)) return current
    if (dirname(current) === current) return null
  }
}

export async function folderChanges(folder: string, deps: FolderChangesDeps): Promise<string> {
  if (!isLocalFilesystemPath(folder)) throw new FolderChangesError(`${folder} is not on this computer, so no changes can be attached.`)
  const root = await repositoryRoot(folder)
  if (!root) throw new FolderChangesError(`${folder} is not a Git repository, so there are no changes to attach.`)
  const entry = await inspectGitEntry(root)
  if (!entry) throw new FolderChangesError(`${root} has no .git entry the desktop can open.`)
  if (entry.issue) throw new FolderChangesError(`The repository in ${root} is not opened: ${entry.issue}.`)

  const maxOutputBytes = deps.maxOutputBytes ?? 16 * 1024 * 1024
  // From the root, and never above it: Git finds the repository that was inspected, not one further up.
  const ceiling = ceilingDirectories(root)
  const git = (args: readonly string[]): Promise<GitRunResult> => deps.runner.run({
    cwd: root, args, kind: 'read', timeoutMs: GIT_TIMEOUT_MS, maxStdoutBytes: maxOutputBytes,
    environment: ceiling ? { extra: { GIT_CEILING_DIRECTORIES: ceiling } } : undefined,
  })
  /** A command that must succeed: its output, or an error that says why it did not. */
  const output = async (args: readonly string[], what: string, okCodes: readonly number[] = [0]): Promise<string> => {
    const result = await git(args)
    if (result.timedOut) throw new FolderChangesError(`Git did not answer within ${GIT_TIMEOUT_MS / 1000} s while reading ${what}.`)
    if (result.stdoutTruncated) throw new FolderChangesError(`The ${what} are larger than ${Math.round(maxOutputBytes / 1024 / 1024) || '<1'} MB, too large to attach. Describe them in the post instead.`)
    if (result.exitCode === null || !okCodes.includes(result.exitCode)) throw new FolderChangesError(`Git could not read the ${what}: ${result.stderr.trim().split(/\r?\n/, 1)[0] || `exit code ${result.exitCode}`}`)
    return result.stdout.toString('utf8')
  }

  const scan = await scanRepoConfig(deps.runner, root)
  if (scan.items.length > 0 && !(await deps.trust.isTrusted(root, scan.hash))) {
    throw new FolderChangesError(`The Git settings of ${root} name programs Git could run (${scan.items.map((item) => item.key).join(', ')}). The person has to review them in the Git panel first; then the changes can be attached.`)
  }

  let patch = ''
  if ((await git(['rev-parse', '--verify', '--quiet', 'HEAD'])).exitCode === 0) patch += await output([...DIFF, 'HEAD'], 'tracked changes')
  const untracked = (await output(['ls-files', '--others', '--exclude-standard', '-z'], 'new files')).split('\0').filter(Boolean)
  let included = 0
  for (const path of untracked) {
    const size = await stat(join(root, path)).then((info) => info.isFile() ? info.size : null, () => null)
    if (included >= MAX_NEW_FILES || size === null || size > MAX_NEW_FILE_BYTES || patch.length > MAX_PATCH_CHARS) {
      patch += `# New file not included: ${path}\n`
      continue
    }
    // `diff --no-index` answers 1 when the files differ, which a new file always does.
    const added = await output([...DIFF, '--no-index', '--', '/dev/null', path], `new file ${path}`, [0, 1])
    if (added) { patch += added.endsWith('\n') ? added : `${added}\n`; included++ }
  }
  return patch.trim() ? patch : '# No uncommitted changes.'
}
