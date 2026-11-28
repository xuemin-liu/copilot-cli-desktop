import { isPermissionPreset, type PermissionPreset } from '../main/permission-presets.js'
import { isResumeMode, type ResumeMode } from '../main/resume-args.js'
import { isValidSessionId } from '../main/session-id.js'

export const START_OPTION_FLAGS = {
  preset: '--preset',
  resumeMode: '--resume-mode',
  sessionId: '--session-id',
} as const

export type StartValueFlag = typeof START_OPTION_FLAGS[keyof typeof START_OPTION_FLAGS]
export const START_VALUE_FLAGS: readonly StartValueFlag[] = Object.values(START_OPTION_FLAGS)

export interface ParsedStartArguments {
  workspace: string | undefined
  preset: PermissionPreset
  resumeMode: ResumeMode
  sessionId: string | null
  normalizedOptionArgs: string[]
}

function matchEqualsFlag(argument: string): { flag: StartValueFlag; value: string } | null {
  for (const flag of START_VALUE_FLAGS) {
    if (argument.startsWith(`${flag}=`)) {
      return { flag, value: argument.slice(flag.length + 1) }
    }
  }
  return null
}

function validateFlagValue(flag: StartValueFlag, value: string): void {
  if (value.length === 0) throw new Error(`${flag} requires a value`)
  if (value.includes('\0')) throw new Error(`${flag} contains an invalid null character`)
  switch (flag) {
    case START_OPTION_FLAGS.preset:
      if (!isPermissionPreset(value)) throw new Error(`Invalid --preset value: ${value}`)
      break
    case START_OPTION_FLAGS.resumeMode:
      if (!isResumeMode(value)) throw new Error(`Invalid --resume-mode value: ${value}`)
      break
    case START_OPTION_FLAGS.sessionId:
      if (!isValidSessionId(value)) throw new Error(`Invalid --session-id value: ${value}`)
      break
  }
}

export function parseStartArguments(
  args: readonly string[],
  options: { allowWorkspace?: boolean } = {},
): ParsedStartArguments {
  const allowWorkspace = options.allowWorkspace ?? true
  let workspace: string | undefined
  let preset: PermissionPreset = 'default'
  let resumeMode: ResumeMode = 'new'
  let sessionId: string | null = null

  const applyFlag = (flag: StartValueFlag, value: string): void => {
    validateFlagValue(flag, value)
    if (flag === START_OPTION_FLAGS.preset) preset = value as PermissionPreset
    else if (flag === START_OPTION_FLAGS.resumeMode) resumeMode = value as ResumeMode
    else sessionId = value
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (START_VALUE_FLAGS.includes(argument as StartValueFlag)) {
      const flag = argument as StartValueFlag
      const value = args[++index]
      if (value === undefined) throw new Error(`${flag} requires a value`)
      applyFlag(flag, value)
      continue
    }
    const inline = matchEqualsFlag(argument)
    if (inline) {
      applyFlag(inline.flag, inline.value)
      continue
    }
    if (argument.startsWith('-')) {
      throw new Error(`Unknown start option: ${argument}`)
    }
    if (!allowWorkspace || workspace !== undefined) {
      throw new Error(`Unexpected start argument: ${argument}`)
    }
    if (argument.includes('\0')) {
      throw new Error('Workspace path contains an invalid null character')
    }
    workspace = argument
  }

  const normalizedOptionArgs = [
    START_OPTION_FLAGS.preset, preset,
    START_OPTION_FLAGS.resumeMode, resumeMode,
    ...(sessionId !== null ? [START_OPTION_FLAGS.sessionId, sessionId] : []),
  ]
  return { workspace, preset, resumeMode, sessionId, normalizedOptionArgs }
}

export function flagValue(args: readonly string[], name: StartValueFlag): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === name) return args[index + 1]
    if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1)
    if (START_VALUE_FLAGS.includes(argument as StartValueFlag)) index += 1
  }
  return undefined
}

export function findWorkspaceArgument(args: readonly string[]): string | undefined {
  return parseStartArguments(args).workspace
}
