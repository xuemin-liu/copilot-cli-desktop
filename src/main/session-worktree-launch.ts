import { join, win32 } from 'node:path'
import { tmpdir } from 'node:os'
import { GitRunner, gitSucceeded, resolveGitExecutable } from './git-runner.js'
import type { GitRunOptions, GitRunResult } from './git-runner.js'
import type { SpawnOptions } from './pty-backend.js'
import { normalizeWorktreeTimeoutMinutes } from './worktree-timeout.js'

type RunGit = (options: GitRunOptions) => Promise<GitRunResult>

/** Avoid Copilot's short git-write timeout when checking out a large repository. */
export async function prepareSessionWorktree(
  args: string[], options: SpawnOptions, runGit?: RunGit,
): Promise<{ args: string[]; options: SpawnOptions }> {
  const flag = args.find(argument => argument.startsWith('--worktree='))
  if (!flag) return { args, options }
  const name = flag.slice('--worktree='.length)
  // Only intercept worktrees named by the desktop, never arbitrary paths or CLI options.
  if (!/^desktop-[a-z0-9-]+-[0-9a-f]{6}$/.test(name)) throw new Error('Invalid session worktree name')
  if (!runGit) {
    const executable = await resolveGitExecutable({ env: options.env })
    if (!executable) throw new Error('Git is required to create a session worktree')
    const runner = new GitRunner({ gitPath: executable.path, baseEnvironment: options.env,
      hooksDirectory: join(tmpdir(), 'copilot-desktop-no-hooks') })
    runGit = request => runner.run(request)
  }
  const execute = runGit
  const run = async (request: GitRunOptions): Promise<GitRunResult> => {
    const result = await execute({ ...request, signal: options.signal })
    if (!gitSucceeded(result)) {
      const reason = result.cancelled ? 'cancelled' : result.timedOut ? 'timed out' : result.stderr.trim().slice(-2000) || 'Git failed'
      throw new Error(`Could not create session worktree: ${reason}`)
    }
    return result
  }
  // The first entry is the main checkout, even when launched from a linked worktree or subfolder.
  const listed = await run({ cwd: options.cwd, args: ['worktree', 'list', '--porcelain', '-z'] })
  const first = listed.stdout.toString('utf8').split('\0')[0]
  if (!first?.startsWith('worktree ')) throw new Error('Could not locate the main Git checkout')
  const target = win32.join(`${first.slice('worktree '.length)}.worktrees`, name)
  await run({ cwd: options.cwd, kind: 'write', disableHooks: true,
    args: ['worktree', 'add', '-b', name, target, 'HEAD'],
    timeoutMs: normalizeWorktreeTimeoutMinutes(options.worktreeTimeoutMinutes) * 60_000 })
  return { args: args.filter(argument => argument !== flag), options: { ...options, cwd: target } }
}
