import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CopilotResolution } from './types.js'
import { withCopilotPathAdditions } from './resolve-copilot.js'

const execFileAsync = promisify(execFile)
// Help loads the same CLI runtime as --version, which can take longer on a
// cold Windows start (especially through an npm loader).
const CAPABILITY_PROBE_TIMEOUT_MS = 30_000
// The retry is a warm load: cap it at five seconds so two hung probes block
// their caller for at most ~36 seconds (30s + 1s delay + 5s).
const CAPABILITY_RETRY_TIMEOUT_MS = 5_000
const CAPABILITY_RETRY_DELAY_MS = 1_000

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

export interface CopilotCommandResult {
  stdout: string
  stderr: string
}

export function buildCopilotCommandArgs(
  resolution: Pick<CopilotResolution, 'prefixArgs'>,
  args: readonly string[],
): string[] {
  return [...resolution.prefixArgs, ...args]
}

export async function runCopilotCommand(
  resolution: CopilotResolution,
  args: readonly string[],
  options: {
    timeout?: number | undefined
    cwd?: string | undefined
    env?: NodeJS.ProcessEnv | undefined
    signal?: AbortSignal | undefined
  } = {},
): Promise<CopilotCommandResult> {
  if (resolution.version === null) throw new Error('Copilot CLI is not installed')
  const env = withCopilotPathAdditions(options.env ?? process.env, resolution.pathAdditions)
  const result = await execFileAsync(
    resolution.command,
    buildCopilotCommandArgs(resolution, args),
    {
      env,
      timeout: options.timeout ?? 30_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  )
  return { stdout: result.stdout, stderr: result.stderr }
}

export interface CopilotCapabilities {
  sessionIdentity: boolean
  toolAllowlist: boolean
  launchProfiles: boolean
  remoteSessions: boolean
  plugins: boolean
  acp: boolean
  supportedOptions: string[]
  probeFailed: boolean
}

export const EMPTY_COPILOT_CAPABILITIES: CopilotCapabilities = {
  sessionIdentity: false,
  toolAllowlist: false,
  launchProfiles: false,
  remoteSessions: false,
  plugins: false,
  acp: false,
  supportedOptions: [],
  probeFailed: false,
}

export function parseCopilotCapabilities(helpText: string): CopilotCapabilities {
  const supportedOptions = [...new Set([...helpText.matchAll(/--[a-z][a-z0-9-]*/g)].map((match) => match[0]!))].sort()
  const hasOption = (option: string): boolean => supportedOptions.includes(option)
  return {
    sessionIdentity: hasOption('--session-id') && hasOption('--name'),
    toolAllowlist: hasOption('--available-tools'),
    launchProfiles: hasOption('--model') && hasOption('--mode') && hasOption('--effort'),
    remoteSessions: hasOption('--remote') && hasOption('--connect'),
    plugins: /\bcopilot plugins?\b|--plugin-dir|\/plugins/.test(helpText),
    acp: hasOption('--acp'),
    supportedOptions,
    probeFailed: false,
  }
}

export async function discoverCopilotCapabilities(
  resolution: CopilotResolution,
  runCommand: typeof runCopilotCommand = runCopilotCommand,
  waitForRetry: (milliseconds: number) => Promise<void> = delay,
): Promise<CopilotCapabilities> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // Query the top-level option reference to validate workspace launch flags.
      const timeout = attempt === 0 ? CAPABILITY_PROBE_TIMEOUT_MS : CAPABILITY_RETRY_TIMEOUT_MS
      const result = await runCommand(resolution, ['--help'], { timeout })
      return parseCopilotCapabilities(`${result.stdout}\n${result.stderr}`)
    } catch {
      // A just-installed CLI or an antivirus scan can make the first probe
      // transiently fail. Pause before one bounded retry so the condition has
      // time to clear before a shorter warm-start retry.
      if (attempt === 0) await waitForRetry(CAPABILITY_RETRY_DELAY_MS)
    }
  }
  return { ...EMPTY_COPILOT_CAPABILITIES, probeFailed: true }
}
