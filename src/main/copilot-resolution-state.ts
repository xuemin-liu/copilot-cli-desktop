import type { CopilotResolution } from './types.js'

export function sameCopilotResolution(left: CopilotResolution | null, right: CopilotResolution): boolean {
  return left?.kind === right.kind
    && left.command === right.command
    && left.resolvedPath === right.resolvedPath
    && left.version === right.version
    && JSON.stringify(left.prefixArgs) === JSON.stringify(right.prefixArgs)
    && JSON.stringify(left.pathAdditions ?? []) === JSON.stringify(right.pathAdditions ?? [])
}

/** Keep a known-good CLI available when a background refresh briefly races
 * an in-place CLI update. Explicit startup/manual resolution still reports a
 * genuine missing installation because it does not use this refresh policy. */
export function shouldAdoptRefreshedResolution(
  current: CopilotResolution | null,
  candidate: CopilotResolution,
): boolean {
  if (sameCopilotResolution(current, candidate)) return false
  return current?.version === null || current === null || candidate.version !== null
}
