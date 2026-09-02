import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { delimiter, win32 } from 'node:path'
import { promisify } from 'node:util'
import type { CopilotResolution } from './types.js'

const execFileAsync = promisify(execFile)
const COPILOT_PROBE_TIMEOUT_MS = 8_000
const COPILOT_PACKAGE_PATH = ['@github', 'copilot'] as const
const COPILOT_PACKAGE_MARKER = `\\node_modules\\${COPILOT_PACKAGE_PATH.join('\\')}\\`

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; windowsHide: boolean; cwd?: string | undefined },
) => Promise<{ stdout: string; stderr: string }>

export type ReadTextFileFn = (path: string) => Promise<string>

const defaultExecFile: ExecFileFn = (file, args, options) => execFileAsync(file, args, options)
const defaultReadTextFile: ReadTextFileFn = (path) => readFile(path, 'utf8')

export function windowsSystemDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32')
}

/** Resolve a Windows system utility without searching the workspace CWD. */
export function windowsSystemExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(windowsSystemDirectory(env), name)
}

function parseVersion(output: string): string | null {
  const firstLine = output.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
  const semverMatch = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(firstLine)
  return semverMatch?.[1] ?? (firstLine.length > 0 ? firstLine : null)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function tryVersion(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  execFileFn: ExecFileFn,
): Promise<{ ok: true; version: string | null } | { ok: false; error: unknown }> {
  try {
    const { stdout, stderr } = await execFileFn(command, args, {
      env,
      timeout: COPILOT_PROBE_TIMEOUT_MS,
      windowsHide: true,
    })
    return { ok: true, version: parseVersion(stdout || stderr) }
  } catch (error) {
    return { ok: false, error }
  }
}

async function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  execFileFn: ExecFileFn,
): Promise<{ paths: string[]; error: unknown | null }> {
  const systemDirectory = windowsSystemDirectory(env)
  try {
    const { stdout } = await execFileFn(
      windowsSystemExecutable('where.exe', env),
      [command],
      { env, cwd: systemDirectory, timeout: COPILOT_PROBE_TIMEOUT_MS, windowsHide: true },
    )
    const paths = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => win32.isAbsolute(line) && /\.(exe|cmd|bat)$/i.test(line))
    return {
      paths,
      error: paths.length > 0 ? null : new Error('no absolute executable or command shim was returned'),
    }
  } catch (error) {
    return { paths: [], error }
  }
}

/** Find an absolute `.exe` through System32 where.exe from a trusted CWD. */
export async function findWindowsExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  execFileFn: ExecFileFn = defaultExecFile,
): Promise<string | null> {
  const located = await resolveWindowsCommand(command, env, execFileFn)
  return located.paths.find((candidate) => candidate.toLowerCase().endsWith('.exe')) ?? null
}

function packageBinEntry(manifest: unknown): string | null {
  if (!manifest || typeof manifest !== 'object') return null
  const bin = (manifest as { bin?: unknown }).bin
  if (typeof bin === 'string') return bin
  if (!bin || typeof bin !== 'object' || Array.isArray(bin)) return null
  const entries = Object.entries(bin as Record<string, unknown>)
  const value = entries.find(([name]) => name === 'copilot')?.[1] ?? (entries.length === 1 ? entries[0]?.[1] : undefined)
  return typeof value === 'string' && value.length > 0 ? value : null
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relative = win32.relative(parent, candidate)
  return relative.length > 0 && !relative.startsWith(`..${win32.sep}`) && relative !== '..' && !win32.isAbsolute(relative)
}

function shimPackageEntries(shimText: string, shimDirectory: string): string[] {
  if (shimText.length > 64 * 1024) return []
  const entries: string[] = []
  const pattern = /(?:%~dp0|%dp0%)[\\/]([^"%\r\n]+?\.(?:c?js|mjs|exe))(?=["\s]|$)/gi
  for (const match of shimText.matchAll(pattern)) {
    const relative = match[1]?.trim()
    if (!relative) continue
    entries.push(win32.resolve(shimDirectory, relative))
  }
  return [...new Set(entries)]
}

function packageDirectoryForEntry(entry: string): string | null {
  const normalized = entry.replaceAll('/', '\\')
  const markerIndex = normalized.toLowerCase().lastIndexOf(COPILOT_PACKAGE_MARKER.toLowerCase())
  if (markerIndex < 0) return null
  return normalized.slice(0, markerIndex + COPILOT_PACKAGE_MARKER.length - 1)
}

async function locateNodeExecutable(
  shimDirectory: string,
  env: NodeJS.ProcessEnv,
  execFileFn: ExecFileFn,
  pathExists: (path: string) => boolean,
): Promise<string | null> {
  const candidates = [
    win32.join(shimDirectory, 'node.exe'),
    env.ProgramFiles && win32.join(env.ProgramFiles, 'nodejs', 'node.exe'),
    env.ProgramW6432 && win32.join(env.ProgramW6432, 'nodejs', 'node.exe'),
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of [...new Set(candidates)]) {
    if (pathExists(candidate)) return candidate
  }
  const located = await resolveWindowsCommand('node', env, execFileFn)
  return located.paths.find((candidate) => candidate.toLowerCase().endsWith('.exe')) ?? null
}

/**
 * Windows package-manager shims ultimately invoke an installed package entry
 * with Node. Resolve the target declared by the shim, then verify it against
 * @github/copilot's manifest and execute it directly. This supports npm,
 * pnpm, and Yarn layouts without crossing a cmd.exe parser.
 */
async function unwrapCopilotNpmShim(
  shimPath: string,
  env: NodeJS.ProcessEnv,
  execFileFn: ExecFileFn,
  pathExists: (path: string) => boolean,
  readTextFile: ReadTextFileFn,
): Promise<Pick<CopilotResolution, 'command' | 'prefixArgs' | 'resolvedPath' | 'pathAdditions'> | null> {
  if (win32.basename(shimPath).toLowerCase() !== 'copilot.cmd') return null
  const shimDirectory = win32.dirname(shimPath)
  let shimText: string
  try {
    shimText = await readTextFile(shimPath)
  } catch {
    return null
  }

  for (const declaredEntry of shimPackageEntries(shimText, shimDirectory)) {
    const packageDirectory = packageDirectoryForEntry(declaredEntry)
    if (!packageDirectory) continue
    let manifest: unknown
    try {
      manifest = JSON.parse(await readTextFile(win32.join(packageDirectory, 'package.json')))
    } catch {
      continue
    }
    if ((manifest as { name?: unknown }).name !== '@github/copilot') continue
    const relativeEntry = packageBinEntry(manifest)
    if (!relativeEntry) continue
    const entry = win32.resolve(packageDirectory, relativeEntry)
    if (
      !isContainedPath(packageDirectory, entry)
      || entry.toLowerCase() !== declaredEntry.toLowerCase()
      || !pathExists(entry)
    ) continue
    if (entry.toLowerCase().endsWith('.exe')) {
      return { command: entry, prefixArgs: [], resolvedPath: shimPath, pathAdditions: [] }
    }
    const node = await locateNodeExecutable(shimDirectory, env, execFileFn, pathExists)
    if (!node) return null
    return {
      command: node,
      prefixArgs: [entry],
      resolvedPath: shimPath,
      pathAdditions: [win32.dirname(node)],
    }
  }
  return null
}

export function withCopilotPathAdditions(
  env: NodeJS.ProcessEnv,
  additions: readonly string[] | undefined = [],
): NodeJS.ProcessEnv {
  if (!additions || additions.length === 0) return env
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path'
  const currentPath = env[pathKey] ?? ''
  return { ...env, [pathKey]: [...additions, currentPath].filter(Boolean).join(delimiter) }
}

async function probeWindowsCopilotPath(
  path: string,
  env: NodeJS.ProcessEnv,
  execFileFn: ExecFileFn,
  pathExists: (path: string) => boolean,
  readTextFile: ReadTextFileFn,
): Promise<Omit<CopilotResolution, 'kind' | 'error'> | null> {
  const launch = path.toLowerCase().endsWith('.exe')
    ? { command: path, prefixArgs: [], resolvedPath: path, pathAdditions: [] }
    : await unwrapCopilotNpmShim(path, env, execFileFn, pathExists, readTextFile)
  if (!launch) return null
  const launchEnv = withCopilotPathAdditions(env, launch.pathAdditions)
  const result = await tryVersion(launch.command, [...launch.prefixArgs, '--version'], launchEnv, execFileFn)
  if (!result.ok) return null
  return { ...launch, version: result.version }
}

/** Resolve Copilot without ever invoking a command shell. */
export async function resolveCopilotBinary(
  env: NodeJS.ProcessEnv = process.env,
  execFileFn: ExecFileFn = defaultExecFile,
  platform: NodeJS.Platform = process.platform,
  pathExists: (path: string) => boolean = existsSync,
  readTextFile: ReadTextFileFn = defaultReadTextFile,
): Promise<CopilotResolution> {
  const attempts: string[] = []

  if (platform === 'win32') {
    const located = await resolveWindowsCommand('copilot', env, execFileFn)
    for (const path of located.paths) {
      const launch = await probeWindowsCopilotPath(path, env, execFileFn, pathExists, readTextFile)
      if (launch) return { kind: 'direct', ...launch, error: null }
      attempts.push(`${path}: unsupported or failed direct launch`)
    }
    if (located.error) attempts.push(`where.exe copilot: ${describeError(located.error)}`)

    const shimCandidates = [
      env.ProgramFiles && win32.join(env.ProgramFiles, 'nodejs', 'copilot.cmd'),
      env.ProgramW6432 && win32.join(env.ProgramW6432, 'nodejs', 'copilot.cmd'),
      env.APPDATA && win32.join(env.APPDATA, 'npm', 'copilot.cmd'),
    ].filter((candidate): candidate is string => Boolean(candidate))
    for (const candidate of [...new Set(shimCandidates)]) {
      if (!pathExists(candidate) || located.paths.includes(candidate)) continue
      const launch = await probeWindowsCopilotPath(candidate, env, execFileFn, pathExists, readTextFile)
      if (launch) return { kind: 'direct', ...launch, error: null }
      attempts.push(`${candidate}: package-manager shim target could not be verified`)
    }
  } else {
    const direct = await tryVersion('copilot', ['--version'], env, execFileFn)
    if (direct.ok) {
      return { kind: 'direct', command: 'copilot', prefixArgs: [], resolvedPath: null, version: direct.version, error: null }
    }
    attempts.push(`copilot --version: ${describeError(direct.error)}`)
  }

  const localAppData = env.LOCALAPPDATA
  if (localAppData) {
    const candidate = win32.join(localAppData, 'GitHub CLI', 'copilot', 'copilot.exe')
    if (pathExists(candidate)) {
      const result = await tryVersion(candidate, ['--version'], env, execFileFn)
      if (result.ok) {
        return { kind: 'direct', command: candidate, prefixArgs: [], resolvedPath: candidate, version: result.version, error: null }
      }
      attempts.push(`${candidate} --version: ${describeError(result.error)}`)
    }
  }

  if (platform === 'win32') {
    const located = await resolveWindowsCommand('gh', env, execFileFn)
    const ghExe = located.paths.find((candidate) => candidate.toLowerCase().endsWith('.exe'))
    if (ghExe) {
      const wrapped = await tryVersion(ghExe, ['copilot', '--', '--version'], env, execFileFn)
      if (wrapped.ok) {
        return {
          kind: 'gh-wrapped',
          command: ghExe,
          prefixArgs: ['copilot', '--'],
          resolvedPath: ghExe,
          version: wrapped.version,
          error: null,
        }
      }
      attempts.push(`${ghExe} copilot -- --version: ${describeError(wrapped.error)}`)
    } else if (located.error) attempts.push(`where.exe gh: ${describeError(located.error)}`)
  } else {
    const wrapped = await tryVersion('gh', ['copilot', '--', '--version'], env, execFileFn)
    if (wrapped.ok) {
      return { kind: 'gh-wrapped', command: 'gh', prefixArgs: ['copilot', '--'], resolvedPath: null, version: wrapped.version, error: null }
    }
    attempts.push(`gh copilot -- --version: ${describeError(wrapped.error)}`)
  }

  return {
    kind: 'direct',
    command: 'copilot',
    prefixArgs: [],
    resolvedPath: null,
    version: null,
    error: [
      'The Copilot CLI was not found as a directly executable binary or a verifiable npm installation.',
      'Install it with `winget install GitHub.Copilot`, repair the npm installation, or use the Install action in this app.',
      ...attempts,
    ].join('\n'),
  }
}
