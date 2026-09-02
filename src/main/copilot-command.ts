import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CopilotResolution } from './types.js'
import { withCopilotPathAdditions } from './resolve-copilot.js'

const execFileAsync = promisify(execFile)
const CAPABILITY_PROBE_TIMEOUT_MS = 5_000
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
}

export const EMPTY_COPILOT_CAPABILITIES: CopilotCapabilities = {
  sessionIdentity: false,
  toolAllowlist: false,
  launchProfiles: false,
  remoteSessions: false,
  plugins: false,
  acp: false,
  supportedOptions: [],
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
  }
}

export async function discoverCopilotCapabilities(resolution: CopilotResolution): Promise<CopilotCapabilities> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await runCopilotCommand(resolution, ['help'], { timeout: CAPABILITY_PROBE_TIMEOUT_MS })
      return parseCopilotCapabilities(`${result.stdout}\n${result.stderr}`)
    } catch {
      // A just-installed CLI or an antivirus scan can make the first probe
      // transiently fail. Pause before one bounded retry so the condition has
      // time to clear without leaving startup or Settings blocked for a minute.
      if (attempt === 0) await delay(CAPABILITY_RETRY_DELAY_MS)
    }
  }
  return { ...EMPTY_COPILOT_CAPABILITIES }
}
