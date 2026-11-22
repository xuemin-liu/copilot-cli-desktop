import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { writeFileAtomic } from './atomic-file.js'

/**
 * A reviewer session runs a pull request's code (its build and tests), so it must not be able to write to GitHub as the
 * person. Measured on Copilot CLI 1.0.114 on Windows (docs/pr-loops-plan.md, Phase 0):
 * - Only the Copilot home's settings.json sets the command sandbox's policy. A repository's .github/copilot settings,
 *   even in a trusted folder, change nothing, so a PR cannot loosen it, and the desktop has to own the home.
 * - `--sandbox` alone is not enough: with no saved policy it injects a masked GH_TOKEN that GitHub accepts through
 *   its proxy. Git and gh authentication and the per-command bypass have to be turned off in the policy.
 * - A GitHub token in Copilot's own environment reaches sandboxed commands, and GitHub accepts it there. So the
 *   launch environment drops every GitHub token variable; Copilot still signs in from its stored login.
 * - The built-in GitHub MCP server runs outside the sandbox with the person's login. The reviewer launches without
 *   built-in MCP servers and reads the PR through the desktop instead.
 * - The built-in file-edit tool honours the sandbox's denied paths; a deny rule for the home is a second layer.
 */

/** Variables that carry a GitHub token. Copilot and gh read them, and a sandbox passes them through. */
export const GITHUB_TOKEN_VARIABLES = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] as const

export interface ReviewerSandboxPolicy {
  sandbox: {
    enabled: true; allowBypass: false; auth: { git: false; gh: false }; addCurrentWorkingDirectory: true
    userPolicy: { filesystem: { deniedPaths: string[]; readonlyPaths?: string[] } }
  }
}

export interface ReviewerPathRoots {
  reviewerHome: string; userHome: string; personCopilotHome: string; desktopData: string
  /** %APPDATA% and %LOCALAPPDATA% on Windows; null elsewhere. */
  appData: string | null; localAppData: string | null
}

/**
 * The person's files a reviewer must not reach. The sandbox lets commands read the whole user profile by default, so
 * this lists what could act as the person or reveal them: the reviewer's own home (its policy), the person's Copilot
 * home (other sessions' logs), the desktop's data (its browser profile and records), SSH keys, stored Git and gh
 * logins, and browser profiles, whose cookies could sign in to GitHub. A denied path that does not exist makes every
 * sandboxed command fail, so only existing ones are listed; the reviewer home always exists by then.
 */
export function reviewerDeniedPaths(roots: ReviewerPathRoots, exists: (path: string) => boolean = existsSync): string[] {
  const named = [roots.reviewerHome, roots.userHome, roots.personCopilotHome, roots.desktopData, roots.appData, roots.localAppData]
  for (const path of named) if (path !== null && !isAbsolute(path)) throw new Error('Reviewer sandbox paths must be absolute')
  const home = roots.userHome
  const candidates = [roots.reviewerHome, roots.personCopilotHome, roots.desktopData,
    join(home, '.ssh'), join(home, '.git-credentials'), join(home, '.config', 'gh'), join(home, '.netrc'), join(home, '_netrc'),
    join(home, '.mozilla'), join(home, '.config', 'google-chrome'), join(home, '.config', 'chromium'), join(home, '.config', 'microsoft-edge'),
    join(home, 'Library', 'Application Support', 'Google', 'Chrome'), join(home, 'Library', 'Application Support', 'Firefox'),
    join(home, 'Library', 'Application Support', 'Microsoft Edge')]
  if (roots.appData) candidates.push(join(roots.appData, 'GitHub CLI'), join(roots.appData, 'Mozilla'), join(roots.appData, 'Opera Software'))
  if (roots.localAppData) for (const browser of [['Google', 'Chrome'], ['Microsoft', 'Edge'], ['BraveSoftware'], ['Chromium'], ['Vivaldi']]) {
    candidates.push(join(roots.localAppData, ...browser))
  }
  const unique = [...new Set(candidates.map((path) => resolve(path)))]
  const reviewerHome = resolve(roots.reviewerHome)
  return unique.filter((path) => path === reviewerHome || exists(path))
}

/**
 * `readonlyPaths`: folders outside the checkout that its build must read, such as the `node_modules` a desktop worktree
 * links to. The sandbox otherwise allows only the checkout, PATH folders, the temp folder and the user profile.
 */
export function reviewerSandboxPolicy(deniedPaths: readonly string[], readonlyPaths: readonly string[] = []): ReviewerSandboxPolicy {
  for (const path of readonlyPaths) if (!isAbsolute(path)) throw new Error('Reviewer sandbox paths must be absolute')
  const filesystem: ReviewerSandboxPolicy['sandbox']['userPolicy']['filesystem'] = { deniedPaths: [...deniedPaths] }
  if (readonlyPaths.length) filesystem.readonlyPaths = readonlyPaths.map((path) => resolve(path))
  return { sandbox: { enabled: true, allowBypass: false, auth: { git: false, gh: false }, addCurrentWorkingDirectory: true, userPolicy: { filesystem } } }
}

const settingsPath = (reviewerHome: string): string => join(reviewerHome, 'settings.json')

/** Writes the reviewer home's settings. Nothing else is kept there by the desktop. */
export async function writeReviewerHome(reviewerHome: string, deniedPaths: readonly string[], readonlyPaths: readonly string[] = []): Promise<void> {
  await writeFileAtomic(settingsPath(reviewerHome), `${JSON.stringify(reviewerSandboxPolicy(deniedPaths, readonlyPaths), null, 2)}\n`)
}

/**
 * Checks, just before a reviewer starts, that the home still holds exactly the policy the desktop wrote. The sandbox
 * denies the session this folder, but the person, or another program, can still edit it. Anything else in the settings
 * (a model choice the person made, say) is allowed; the sandbox block must match exactly.
 */
export async function verifyReviewerHome(reviewerHome: string, deniedPaths: readonly string[], readonlyPaths: readonly string[] = []): Promise<void> {
  let parsed: unknown
  try { parsed = JSON.parse(await readFile(settingsPath(reviewerHome), 'utf8')) } catch { throw new Error('The reviewer sandbox settings are missing or unreadable') }
  const actual = (parsed as { sandbox?: unknown } | null)?.sandbox
  if (JSON.stringify(actual) !== JSON.stringify(reviewerSandboxPolicy(deniedPaths, readonlyPaths).sandbox)) throw new Error('The reviewer sandbox settings were changed')
  const settings = parsed as Record<string, unknown>
  // These settings widen the GitHub tools beyond reads; the launch disables built-in MCP servers, but a stray setting
  // here would still say the home was tampered with.
  for (const key of ['enableAllGithubMcpTools', 'githubMcpToolsets', 'githubMcpTools', 'enabledMcpServers']) {
    if (key in settings) throw new Error('The reviewer sandbox settings were changed')
  }
}

/** The arguments every reviewer launch adds. The deny rule covers the built-in edit tools, which are not OS-sandboxed. */
export function reviewerLaunchArguments(reviewerHome: string): string[] {
  return ['--sandbox', '--disable-builtin-mcps', '--deny-tool', `write(${join(resolve(reviewerHome), '**')})`]
}

/** The launch environment: the reviewer home, and no GitHub token, which a sandbox would otherwise pass through. */
export function reviewerEnvironment(env: NodeJS.ProcessEnv, reviewerHome: string): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, COPILOT_HOME: resolve(reviewerHome) }
  for (const key of Object.keys(next)) if ((GITHUB_TOKEN_VARIABLES as readonly string[]).includes(key.toUpperCase())) delete next[key]
  return next
}
