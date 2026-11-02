import type { PermissionPreset } from './permission-presets.js'
export interface TaskReportingCapability { version: string | null; sideChat: boolean; preset: PermissionPreset | null; remote?: boolean }
/** CLI evidence and an available shell are both required; this never grants extra tool permissions. */
export function supportsTaskReporting(capability: TaskReportingCapability | undefined): boolean {
  return capability?.version === '1.0.105' && !capability.sideChat && !capability.remote && capability.preset !== null && capability.preset !== 'read-only'
}
