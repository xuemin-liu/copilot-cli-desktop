export const START_OPTION_FLAGS = {
  preset: '--preset',
  resumeMode: '--resume-mode',
  sessionId: '--session-id',
} as const

export type StartValueFlag = typeof START_OPTION_FLAGS[keyof typeof START_OPTION_FLAGS]
export const START_VALUE_FLAGS: readonly StartValueFlag[] = Object.values(START_OPTION_FLAGS)

export function flagValue(args: readonly string[], name: StartValueFlag): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

export function findWorkspaceArgument(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (START_VALUE_FLAGS.includes(argument as StartValueFlag)) {
      index += 1
      continue
    }
    if (!argument.startsWith('--')) return argument
  }
  return undefined
}
