import { buildPermissionArgs, isPermissionPreset, type PermissionPreset } from '../main/permission-presets.js'
import type { CopilotCapabilities } from '../main/copilot-command.js'

export interface ProgrammaticRunOptions {
  workspace: string | undefined
  prompt: string
  preset: PermissionPreset
  model: string | null
  agent: string | null
  outputFormat: 'text' | 'json'
  silent: boolean
  share: string | null
  autopilot: boolean
  maxAiCredits: number | null
}

const VALUE_FLAGS = new Set([
  '--prompt', '-p', '--preset', '--model', '--agent', '--output-format', '--share', '--max-ai-credits',
])

export function parseProgrammaticRunArguments(args: readonly string[]): ProgrammaticRunOptions {
  let workspace: string | undefined
  let prompt = ''
  let preset: PermissionPreset = 'default'
  let model: string | null = null
  let agent: string | null = null
  let outputFormat: 'text' | 'json' = 'text'
  let silent = false
  let share: string | null = null
  let autopilot = false
  let maxAiCredits: number | null = null

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (VALUE_FLAGS.has(argument)) {
      const value = args[++index]
      if (value === undefined) throw new Error(`${argument} requires a value`)
      if (value.includes('\0')) throw new Error(`${argument} contains an invalid null character`)
      switch (argument) {
        case '--prompt':
        case '-p': prompt = value; break
        case '--preset':
          if (!isPermissionPreset(value)) throw new Error('Invalid --preset value')
          preset = value
          break
        case '--model': model = value; break
        case '--agent': agent = value; break
        case '--output-format':
          if (value !== 'text' && value !== 'json') throw new Error('--output-format must be text or json')
          outputFormat = value
          break
        case '--share': share = value; break
        case '--max-ai-credits': {
          const parsed = Number(value)
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100_000) {
            throw new Error('--max-ai-credits must be an integer between 1 and 100000')
          }
          maxAiCredits = parsed
          break
        }
      }
      continue
    }
    if (argument === '--silent' || argument === '-s') silent = true
    else if (argument === '--autopilot') autopilot = true
    else if (argument.startsWith('-')) throw new Error(`Unknown run option: ${argument}`)
    else if (workspace === undefined) workspace = argument
    else throw new Error(`Unexpected run argument: ${argument}`)
  }
  if (!prompt.trim()) throw new Error('run requires --prompt TEXT')
  return { workspace, prompt, preset, model, agent, outputFormat, silent, share, autopilot, maxAiCredits }
}

export function buildProgrammaticCopilotArgs(
  options: ProgrammaticRunOptions,
  workspace: string,
  capabilities: Pick<CopilotCapabilities, 'toolAllowlist'>,
): string[] {
  return [
    '--prompt', options.prompt,
    '--output-format', options.outputFormat,
    ...(options.silent ? ['--silent'] : []),
    ...(options.model ? ['--model', options.model] : []),
    ...(options.agent ? ['--agent', options.agent] : []),
    ...(options.share ? ['--share', options.share] : []),
    ...(options.autopilot ? ['--autopilot'] : []),
    ...(options.maxAiCredits !== null ? ['--max-ai-credits', String(options.maxAiCredits)] : []),
    ...buildPermissionArgs(options.preset, workspace, capabilities),
  ]
}
