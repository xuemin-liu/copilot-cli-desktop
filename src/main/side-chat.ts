import type { CopilotCapabilities } from './copilot-command.js'
import type { WorkspaceProfile } from './types.js'

/** A side discussion must never inherit an autopilot or full-access profile,
 * including on restart and app relaunch. This is a model-tool restriction,
 * not an OS sandbox: both processes still share the workspace filesystem.
 */
export function sideChatProfile(profile: WorkspaceProfile, capabilities: CopilotCapabilities): WorkspaceProfile {
  if (!capabilities.toolAllowlist) throw new Error('Side chat requires Copilot CLI tool allowlists. Update Copilot CLI from Settings.')
  return {
    ...profile,
    permissionPreset: 'read-only',
    launch: {
      ...profile.launch,
      mode: 'interactive',
      agent: '',
      worktree: false,
      maxAutopilotContinues: null,
      remoteControl: 'disable',
      remoteExport: 'disable',
    },
  }
}

export const SIDE_CHAT_PERMISSION_WARNING = 'Read/search tools only; shared workspace, not an OS sandbox. Local CLI hooks and manually entered commands are not isolated.'
