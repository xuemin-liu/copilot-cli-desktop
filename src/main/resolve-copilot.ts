import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, win32 } from 'node:path'
import { promisify } from 'node:util'
import type { CopilotResolution } from './types.js'

const execFileAsync = promisify(execFile)
const COPILOT_PROBE_TIMEOUT_MS = 20_000

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; windowsHide: boolean },
) => Promise<{ stdout: string; stderr: string }>

const defaultExecFile: ExecFileFn = (file, args, options) => execFileAsync(file, args, options)

function parseVersion(output: string): string | null {
  // `copilot --version` output is unverified (the binary isn't available in
  // this sandbox); accept the first line and also try to pull a semver-shaped
  // token out of it so a banner like "GitHub Copilot CLI 0.1.2" still yields
  // a clean version string.
  const firstLine = output.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
  const semverMatch = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(firstLine)
  return semverMatch?.[1] ?? (firstLine.length > 0 ? firstLine : null)
}

async function tryVersion(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  execFileFn: ExecFileFn,
): Promise<{ ok: true; version: string | null } | { ok: false; error: unknown }> {
  try {
    const { stdout, stderr } = await execFileFn(command, args, { env, timeout: COPILOT_PROBE_TIMEOUT_MS, windowsHide: true })
    return { ok: true, version: parseVersion(stdout || stderr) }
  } catch (error) {
    return { ok: false, error }
  }
}

async function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  execFileFn: ExecFileFn,
): Promise<{ path: string | null; error: unknown | null }> {
  try {
    const { stdout } = await execFileFn('where.exe', [command], { env, timeout: COPILOT_PROBE_TIMEOUT_MS, windowsHide: true })
    const candidates = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => win32.isAbsolute(line) && /\.(exe|cmd|bat)$/i.test(line))
    const path = candidates.find((line) => line.toLowerCase().endsWith('.exe')) ?? candidates[0]
    return { path: path ?? null, error: path ? null : new Error('no absolute executable or command shim was returned') }
  } catch (error) {
    return { path: null, error }
  }
}

function windowsLaunch(path: string, env: NodeJS.ProcessEnv): Pick<CopilotResolution, 'command' | 'prefixArgs' | 'resolvedPath'> {
  if (path.toLowerCase().endsWith('.exe')) return { command: path, prefixArgs: [], resolvedPath: path }
  // Use cmd.exe's CALL command for .cmd/.bat shims. Passing a quoted shim as
  // the command immediately after `/c` interacts badly with cmd.exe's `/s`
  // quote stripping (the quotes can become literal characters). CALL accepts
  // the shim as a normal, separately quoted argument and forwards everything
  // after it, including paths such as C:\Program Files\nodejs\copilot.cmd.
  return {
    command: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
    prefixArgs: ['/d', '/s', '/c', 'call', path],
    resolvedPath: path,
  }
}

export function withCopilotPathAdditions(
  env: NodeJS.ProcessEnv,
  additions: readonly string[] | undefined = [],
): NodeJS.ProcessEnv {
  if (!additions || additions.length === 0) return env
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path'
  const currentPath = env[pathKey] ?? ''
  return { ...env, [pathKey]: [...additions, currentPath].filter(Boolean).join(';') }
}

/**
 * Resolve how to launch the GitHub Copilot CLI:
 *  1. `copilot` directly on PATH.
 *  2. The legacy GitHub CLI-managed location:
 *     `%LOCALAPPDATA%\GitHub CLI\copilot\copilot.exe`.
 *  3. A compatible `gh copilot -- <args>` installation, when present.
 * Diagnostics from every attempt are preserved on `error` for a recovery
 * dashboard when nothing resolves.
 */
export async function resolveCopilotBinary(
  env: NodeJS.ProcessEnv = process.env,
  execFileFn: ExecFileFn = defaultExecFile,
  platform: NodeJS.Platform = process.platform,
  pathExists: (path: string) => boolean = existsSync,
): Promise<CopilotResolution> {
  const attempts: string[] = []

  if (platform === 'win32') {
    const located = await resolveWindowsCommand('copilot', env, execFileFn)
    if (located.path) {
      const launch = windowsLaunch(located.path, env)
      const direct = await tryVersion(launch.command, [...launch.prefixArgs, '--version'], env, execFileFn)
      if (direct.ok) {
        return { kind: 'direct', ...launch, version: direct.version, error: null }
      }
      attempts.push(`${located.path} --version: ${direct.error instanceof Error ? direct.error.message : String(direct.error)}`)
    } else {
      attempts.push(`where.exe copilot: ${located.error instanceof Error ? located.error.message : String(located.error)}`)
    }

    // Electron can inherit a reduced PATH when launched from another desktop
    // application. npm commonly installs its Windows command shim in one of
    // these locations, so check them explicitly before reporting it missing.
    const shimCandidates = [
      env.ProgramFiles && join(env.ProgramFiles, 'nodejs', 'copilot.cmd'),
      env.ProgramW6432 && join(env.ProgramW6432, 'nodejs', 'copilot.cmd'),
      env.APPDATA && join(env.APPDATA, 'npm', 'copilot.cmd'),
    ].filter((candidate): candidate is string => Boolean(candidate))
    const nodeDirectories = [...new Set([
      env.ProgramFiles && join(env.ProgramFiles, 'nodejs'),
      env.ProgramW6432 && join(env.ProgramW6432, 'nodejs'),
    ].filter((directory): directory is string => Boolean(directory)))]
      .filter((directory) => pathExists(join(directory, 'node.exe')))
    const shimEnvironment = withCopilotPathAdditions(env, nodeDirectories)
    for (const candidate of [...new Set(shimCandidates)]) {
      if (!pathExists(candidate)) continue
      const launch = windowsLaunch(candidate, shimEnvironment)
      const direct = await tryVersion(launch.command, [...launch.prefixArgs, '--version'], shimEnvironment, execFileFn)
      if (direct.ok) {
        return { kind: 'direct', ...launch, version: direct.version, error: null, pathAdditions: nodeDirectories }
      }
      attempts.push(`${candidate} --version: ${direct.error instanceof Error ? direct.error.message : String(direct.error)}`)
    }
  } else {
    const direct = await tryVersion('copilot', ['--version'], env, execFileFn)
    if (direct.ok) {
      return { kind: 'direct', command: 'copilot', prefixArgs: [], resolvedPath: null, version: direct.version, error: null }
    } else {
      attempts.push(`copilot --version: ${direct.error instanceof Error ? direct.error.message : String(direct.error)}`)
    }
  }

  const localAppData = env.LOCALAPPDATA
  if (localAppData) {
    const candidate = join(localAppData, 'GitHub CLI', 'copilot', 'copilot.exe')
    if (pathExists(candidate)) {
      const result = await tryVersion(candidate, ['--version'], env, execFileFn)
      if (result.ok) {
        return { kind: 'direct', command: candidate, prefixArgs: [], resolvedPath: candidate, version: result.version, error: null }
      }
      attempts.push(`${candidate} --version: ${result.error instanceof Error ? result.error.message : String(result.error)}`)
    }
  }

  if (platform === 'win32') {
    const located = await resolveWindowsCommand('gh', env, execFileFn)
    if (located.path) {
      const launch = windowsLaunch(located.path, env)
      const wrapped = await tryVersion(launch.command, [...launch.prefixArgs, 'copilot', '--', '--version'], env, execFileFn)
      if (wrapped.ok) {
        return {
          kind: 'gh-wrapped',
          ...launch,
          prefixArgs: [...launch.prefixArgs, 'copilot', '--'],
          version: wrapped.version,
          error: null,
        }
      }
      attempts.push(`${located.path} copilot -- --version: ${wrapped.error instanceof Error ? wrapped.error.message : String(wrapped.error)}`)
    } else {
      attempts.push(`where.exe gh: ${located.error instanceof Error ? located.error.message : String(located.error)}`)
    }
  } else {
    const wrapped = await tryVersion('gh', ['copilot', '--', '--version'], env, execFileFn)
    if (wrapped.ok) {
      return { kind: 'gh-wrapped', command: 'gh', prefixArgs: ['copilot', '--'], resolvedPath: null, version: wrapped.version, error: null }
    } else {
      attempts.push(`gh copilot -- --version: ${wrapped.error instanceof Error ? wrapped.error.message : String(wrapped.error)}`)
    }
  }

  return {
    kind: 'direct',
    command: 'copilot',
    prefixArgs: [],
    resolvedPath: null,
    version: null,
    error: [
      'The copilot CLI was not found on PATH, at the expected GitHub CLI install location, or via `gh copilot`.',
      'Install it with `winget install GitHub.Copilot` or `npm install -g @github/copilot`, or use the Install action in this app.',
      ...attempts,
    ].join('\n'),
  }
}
