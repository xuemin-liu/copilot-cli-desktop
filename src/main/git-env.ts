import { win32 } from 'node:path'

/**
 * Hardened command line and environment for every git process the desktop starts.
 *
 * A repository is untrusted input: its config, attributes and files can name programs that git
 * runs during an ordinary read. These helpers remove what a flag or variable can remove. Settings
 * that only a per-repository trust check can catch (clean/smudge filters, custom credential
 * helpers, `core.sshCommand`) are the job of the trust gate, not this module.
 */

export type GitCommandKind = 'read' | 'write' | 'network'

/** Variables a git child may inherit. Everything else, including every `GIT_*` entry, is dropped. */
const INHERITED_NAMES = new Set([
  'path', 'pathext', 'systemroot', 'windir', 'systemdrive', 'comspec', 'temp', 'tmp',
  'home', 'homedrive', 'homepath', 'userprofile', 'appdata', 'localappdata', 'programdata',
  'programfiles', 'programfiles(x86)', 'programw6432', 'commonprogramfiles', 'commonprogramfiles(x86)', 'commonprogramw6432',
  'username', 'userdomain', 'computername', 'number_of_processors', 'processor_architecture', 'os',
  'ssh_auth_sock', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  // Chosen by the user, not by a repository: where their own git config and SSH client live.
  'git_ssh', 'git_ssh_command', 'git_ssh_variant',
  'git_config_global', 'git_config_system', 'git_config_nosystem',
])

export interface GitEnvironmentOptions {
  /** Extra variables applied last, for tests and for a computed `GIT_CEILING_DIRECTORIES`. */
  extra?: Record<string, string> | undefined
  /**
   * Fail fast instead of hanging on an SSH host-key or passphrase prompt. Only valid when the
   * caller has checked that `core.sshCommand` is unset, because `GIT_SSH_COMMAND` overrides it.
   */
  sshBatchMode?: boolean | undefined
}

export function buildGitEnvironment(base: NodeJS.ProcessEnv = process.env, options: GitEnvironmentOptions = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && INHERITED_NAMES.has(name.toLowerCase())) env[name] = value
  }
  const hasSshOverride = Object.keys(env).some(name => ['git_ssh', 'git_ssh_command'].includes(name.toLowerCase()))
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_NO_LAZY_FETCH: '1',
    SSH_ASKPASS_REQUIRE: 'never',
    GIT_EDITOR: 'true',
    GIT_PAGER: 'cat',
    LC_ALL: 'C',
  })
  if (options.sshBatchMode && !hasSshOverride) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
  if (options.extra) Object.assign(env, options.extra)
  return env
}

/**
 * Arguments placed before the subcommand. `-c` outranks every config file, so these hold even
 * when the repository's own config says otherwise.
 *
 * `core.hooksPath` is only redirected for reads. Writes run the user's own hooks, as they would
 * from a terminal.
 */
export function gitArgsPrefix(kind: GitCommandKind, hooksDirectory: string): string[] {
  const prefix = [
    '--no-pager',
    '--no-optional-locks',
    '--literal-pathspecs',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.quotepath=off',
    '-c', 'color.ui=false',
    '-c', 'log.showSignature=false',
    '-c', 'gc.auto=0',
    '-c', 'maintenance.auto=false',
    '-c', 'i18n.logOutputEncoding=UTF-8',
  ]
  if (kind === 'read') prefix.push('-c', `core.hooksPath=${hooksDirectory}`)
  return prefix
}

/** Reject text that cannot be a single, literal command-line argument. */
export function assertGitArgument(value: string, label = 'git argument'): void {
  if (typeof value !== 'string') throw new Error(`${label} must be text`)
  if (value.includes('\0')) throw new Error(`${label} must not contain a NUL character`)
}

/** `GIT_CEILING_DIRECTORIES` keeps repository discovery from walking above the project folder. */
export function ceilingDirectories(projectPath: string): string | null {
  const parent = win32.dirname(win32.resolve(projectPath))
  return parent === win32.resolve(projectPath) ? null : parent
}
