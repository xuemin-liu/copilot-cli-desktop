import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The uncommitted changes of a folder the person picked, as a patch, for an outside agent hosting a meeting
 * (docs/meeting-guests-plan.md, phase 3). The same limits as the host helper's `-Changes`: tracked changes against HEAD,
 * then up to 100 new files of at most 512 KB each, while the patch is under 5 MB; anything left out is named. Git runs
 * without external diff or text conversion drivers and with fsmonitor off, so the folder's configuration runs no program.
 */

const MAX_NEW_FILES = 100
const MAX_NEW_FILE_BYTES = 512 * 1024
const MAX_PATCH_CHARS = 5_000_000
const GIT_TIMEOUT_MS = 30_000

const SAFE = ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-c', 'diff.external=']
const DIFF = ['--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/']

function git(folder: string, args: readonly string[], okCodes: readonly number[] = [0]): Promise<string | null> {
  return new Promise((resolveGit) => {
    execFile('git', [...SAFE, ...args], { cwd: folder, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0
      resolveGit(okCodes.includes(code) ? stdout : null)
    })
  })
}

export class FolderChangesError extends Error {
  override name = 'FolderChangesError'
}

export async function folderChanges(folder: string): Promise<string> {
  if ((await git(folder, ['rev-parse', '--is-inside-work-tree']))?.trim() !== 'true') {
    throw new FolderChangesError(`${folder} is not a Git repository, so there are no changes to attach.`)
  }
  let patch = ''
  if (await git(folder, ['rev-parse', '--verify', '--quiet', 'HEAD']) !== null) patch += await git(folder, ['diff', 'HEAD', ...DIFF]) ?? ''
  const untracked = (await git(folder, ['ls-files', '--others', '--exclude-standard', '-z']) ?? '').split('\0').filter(Boolean)
  let included = 0
  for (const path of untracked) {
    const size = await stat(join(folder, path)).then((info) => info.isFile() ? info.size : null, () => null)
    if (included >= MAX_NEW_FILES || size === null || size > MAX_NEW_FILE_BYTES || patch.length > MAX_PATCH_CHARS) {
      patch += `# New file not included: ${path}\n`
      continue
    }
    // `diff --no-index` answers 1 when the files differ, which a new file always does.
    const added = await git(folder, ['diff', '--no-index', ...DIFF, '--', '/dev/null', path], [0, 1])
    if (added) { patch += added.endsWith('\n') ? added : `${added}\n`; included++ }
  }
  return patch.trim() ? patch : '# No uncommitted changes.'
}
