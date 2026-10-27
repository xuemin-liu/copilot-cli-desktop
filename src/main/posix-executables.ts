import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

/**
 * Finding programs on macOS and Linux without a shell. An app opened from Finder or a desktop launcher starts with the
 * system's short PATH, not the one the person's shell sets up (Homebrew, npm's global folder, nvm, ~/.local/bin), so the
 * desktop reads that PATH once at startup and adds the usual package-manager folders.
 */

const LOGIN_SHELL_TIMEOUT_MS = 5_000
const PATH_MARKER = '__COPILOT_DESKTOP_PATH__'

/** The folder a probe runs in: never a workspace, so nothing planted there can be picked up. */
export const POSIX_PROBE_DIRECTORY = '/'

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The absolute folders on PATH, in order. A relative entry (including an empty one, the working folder) never counts. */
export function absolutePathEntries(pathValue: string | undefined): string[] {
  return [...new Set((pathValue ?? '').split(delimiter).filter(entry => entry.length > 0 && isAbsolute(entry)))]
}

/** Find a program by name on PATH, like a shell would, but only in absolute folders. */
export async function findPosixExecutable(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!name || name.includes('/')) return null
  for (const directory of absolutePathEntries(env.PATH)) {
    const candidate = join(directory, name)
    if (await isExecutableFile(candidate)) return candidate
  }
  return null
}

/** Folders package managers install programs into, which a GUI-launched app's PATH usually lacks. */
export function wellKnownBinDirectories(home: string = homedir(), platform: NodeJS.Platform = process.platform): string[] {
  return [
    ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/opt/homebrew/sbin'] : ['/home/linuxbrew/.linuxbrew/bin']),
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, 'bin'),
  ]
}

export type LoginShellRunner = (shell: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<string>

const runLoginShell: LoginShellRunner = (shell, args, env, timeoutMs) => new Promise((resolve, reject) => {
  execFile(shell, args, { env, cwd: POSIX_PROBE_DIRECTORY, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) reject(error)
    else resolve(String(stdout))
  })
})

/**
 * PATH as the person's login shell sets it up, or null when it cannot be read. Startup files may print anything, so only
 * the text between two markers is used, and only its absolute folders.
 */
export async function readLoginShellPath(env: NodeJS.ProcessEnv = process.env, run: LoginShellRunner = runLoginShell): Promise<string | null> {
  const shell = env.SHELL
  if (!shell || !isAbsolute(shell)) return null
  try {
    const output = await run(shell, ['-ilc', `printf '%s%s%s' '${PATH_MARKER}' "$PATH" '${PATH_MARKER}'`],
      { ...env, TERM: 'dumb' }, LOGIN_SHELL_TIMEOUT_MS)
    const start = output.indexOf(PATH_MARKER)
    const end = output.indexOf(PATH_MARKER, start + PATH_MARKER.length)
    if (start < 0 || end < 0) return null
    const entries = absolutePathEntries(output.slice(start + PATH_MARKER.length, end))
    return entries.length ? entries.join(delimiter) : null
  } catch {
    return null
  }
}

/**
 * The PATH the desktop and the sessions it starts should use: the login shell's folders first, then the current PATH,
 * then the usual package-manager folders that exist. Nothing changes on Windows.
 */
export async function desktopPosixPath(env: NodeJS.ProcessEnv = process.env, options: {
  platform?: NodeJS.Platform
  home?: string
  run?: LoginShellRunner
  directoryExists?: (path: string) => Promise<boolean>
} = {}): Promise<string | undefined> {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') return env.PATH
  const exists = options.directoryExists ?? (async (path: string) => (await stat(path).catch(() => null))?.isDirectory() ?? false)
  const shellPath = await readLoginShellPath(env, options.run)
  const extra: string[] = []
  for (const directory of wellKnownBinDirectories(options.home ?? homedir(), platform)) {
    if (await exists(directory)) extra.push(directory)
  }
  const merged = absolutePathEntries([shellPath, env.PATH, extra.join(delimiter)].filter(Boolean).join(delimiter))
  return merged.length ? merged.join(delimiter) : env.PATH
}
