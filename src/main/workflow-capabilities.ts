import type { PermissionPreset } from './permission-presets.js'
export interface TaskReportingCapability { version: string | null; sideChat: boolean; preset: PermissionPreset | null; remote?: boolean }
/**
 * The one Copilot CLI version the workflow features were verified against (docs/workflow-capabilities.md). The match is
 * exact on purpose: passing on one version does not establish support on another, so a newer CLI turns them off until
 * `npm run workflow:check` has passed on it and this is changed.
 */
export const WORKFLOW_CLI_VERSION = '1.0.105'

export function isWorkflowCliVersion(version: string | null | undefined): boolean {
  return version === WORKFLOW_CLI_VERSION
}

/** What to tell the person when the installed CLI is not the verified one; null when it is, or is not known yet. */
export function workflowCliVersionNotice(installed: string | null | undefined): string | null {
  if (!installed || isWorkflowCliVersion(installed)) return null
  return `Task reports and automatic work are verified with Copilot CLI ${WORKFLOW_CLI_VERSION} only. Version ${installed} is installed, so both are off. Task outcomes can still be set by hand.`
}

/** CLI evidence and an available shell are both required; this never grants extra tool permissions. */
export function supportsTaskReporting(capability: TaskReportingCapability | undefined): boolean {
  return isWorkflowCliVersion(capability?.version) && capability !== undefined && !capability.sideChat && !capability.remote && capability.preset !== null && capability.preset !== 'read-only'
}
