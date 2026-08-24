import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, win32 } from 'node:path'
import { promisify } from 'node:util'
import type { CopilotResolution } from './types.js'

const execFileAsync = promisify(execFile)

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
    const { stdout, stderr } = await execFileFn(command, args, { env, timeout: 8_000, windowsHide: true })
    return { ok: true, version: parseVersion(stdout || stderr) }
  } catch (error) {
    return { ok: false, error }
  }
}

async function resolveWindowsExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  execFileFn: ExecFileFn,
): Promise<{ path: string | null; error: unknown | null }> {
  try {
    const { stdout } = await execFileFn('where.exe', [command], { env, timeout: 8_000, windowsHide: true })
    const path = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => win32.isAbsolute(line) && line.toLowerCase().endsWith('.exe'))
    return { path: path ?? null, error: path ? null : new Error('no absolute .exe path was returned') }
  } catch (error) {
    return { path: null, error }
  }
}

/**
 * Resolve how to launch the GitHub Copilot CLI:
 *  1. `copilot` directly on PATH.
 *  2. The location `gh` downloads it to when missing: `%LOCALAPPDATA%\GitHub
 *     CLI\copilot\copilot.exe`.
 *  3. `gh copilot -- <args>`, which downloads the binary on first use.
 * Diagnostics from every attempt are preserved on `error` for a recovery
 * dashboard when nothing resolves.
 */
export async function resolveCopilotBinary(
  env: NodeJS.ProcessEnv = process.env,
  execFileFn: ExecFileFn = defaultExecFile,
  platform: NodeJS.Platform = process.platform,
): Promise<CopilotResolution> {
  const attempts: string[] = []

  const direct = await tryVersion('copilot', ['--version'], env, execFileFn)
  if (direct.ok) {
    if (platform !== 'win32') {
      return { kind: 'direct', command: 'copilot', prefixArgs: [], resolvedPath: null, version: direct.version, error: null }
    }
    const located = await resolveWindowsExecutable('copilot', env, execFileFn)
    if (located.path) {
      return {
        kind: 'direct',
        command: located.path,
        prefixArgs: [],
        resolvedPath: located.path,
        version: direct.version,
        error: null,
      }
    }
    attempts.push(`where.exe copilot: ${located.error instanceof Error ? located.error.message : String(located.error)}`)
  } else {
    attempts.push(`copilot --version: ${direct.error instanceof Error ? direct.error.message : String(direct.error)}`)
  }

  const localAppData = env.LOCALAPPDATA
  if (localAppData) {
    const candidate = join(localAppData, 'GitHub CLI', 'copilot', 'copilot.exe')
    if (existsSync(candidate)) {
      const result = await tryVersion(candidate, ['--version'], env, execFileFn)
      if (result.ok) {
        return { kind: 'direct', command: candidate, prefixArgs: [], resolvedPath: candidate, version: result.version, error: null }
      }
      attempts.push(`${candidate} --version: ${result.error instanceof Error ? result.error.message : String(result.error)}`)
    }
  }

  const wrapped = await tryVersion('gh', ['copilot', '--', '--version'], env, execFileFn)
  if (wrapped.ok) {
    if (platform !== 'win32') {
      return { kind: 'gh-wrapped', command: 'gh', prefixArgs: ['copilot', '--'], resolvedPath: null, version: wrapped.version, error: null }
    }
    const located = await resolveWindowsExecutable('gh', env, execFileFn)
    if (located.path) {
      return {
        kind: 'gh-wrapped',
        command: located.path,
        prefixArgs: ['copilot', '--'],
        resolvedPath: located.path,
        version: wrapped.version,
        error: null,
      }
    }
    attempts.push(`where.exe gh: ${located.error instanceof Error ? located.error.message : String(located.error)}`)
  } else {
    attempts.push(`gh copilot -- --version: ${wrapped.error instanceof Error ? wrapped.error.message : String(wrapped.error)}`)
  }

  return {
    kind: 'direct',
    command: 'copilot',
    prefixArgs: [],
    resolvedPath: null,
    version: null,
    error: [
      'The copilot CLI was not found on PATH, at the expected GitHub CLI install location, or via `gh copilot`.',
      'Install it from https://github.com/github/copilot-cli, or install the GitHub CLI (`gh`) and run `gh extension install github/gh-copilot`.',
      ...attempts,
    ].join('\n'),
  }
}
