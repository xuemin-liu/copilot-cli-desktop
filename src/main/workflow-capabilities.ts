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

/**
 * What to tell the person when the installed CLI is not the verified one; null when it is, or is not known yet.
 * The installed version decides what a new session and automatic work can do. A session that was started on the
 * verified version before the CLI was updated keeps reporting, so `sessionsReporting` says whether any such session is open.
 */
export function workflowCliVersionNotice(installed: string | null | undefined, sessionsReporting = false): string | null {
  if (!installed || isWorkflowCliVersion(installed)) return null
  const limit = `Task reports and automatic work are verified with Copilot CLI ${WORKFLOW_CLI_VERSION} only. Version ${installed} is installed, so automatic work is off and new sessions cannot report.`
  return sessionsReporting
    ? `${limit} Sessions still running ${WORKFLOW_CLI_VERSION} keep reporting.`
    : `${limit} Task outcomes can still be set by hand.`
}

/** Why an automatic launch is refused when the installed CLI is not the verified one; null when it is. */
export function automaticWorkVersionRefusal(installed: string | null | undefined): string | null {
  if (!installed || isWorkflowCliVersion(installed)) return null
  return `Automatic work is verified with Copilot CLI ${WORKFLOW_CLI_VERSION} only, and version ${installed} is installed`
}

/** CLI evidence and an available shell are both required; this never grants extra tool permissions. */
export function supportsTaskReporting(capability: TaskReportingCapability | undefined): boolean {
  return isWorkflowCliVersion(capability?.version) && capability !== undefined && !capability.sideChat && !capability.remote && capability.preset !== null && capability.preset !== 'read-only'
}
