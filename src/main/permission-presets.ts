/** Launch-time permission bundle supplied by a workspace profile. */
export type PermissionPreset = 'default' | 'read-only' | 'trusted-directory' | 'full-auto' | 'full-access'

export const PERMISSION_PRESETS: readonly PermissionPreset[] = [
  'default',
  'read-only',
  'trusted-directory',
  'full-auto',
  'full-access',
]

export interface PermissionPresetInfo {
  id: PermissionPreset
  label: string
  description: string
}

export const PERMISSION_PRESET_INFO: Readonly<Record<PermissionPreset, PermissionPresetInfo>> = {
  'default': {
    id: 'default',
    label: 'Copilot default (uses CLI setting)',
    description:
      'Applies no desktop permission override. Copilot CLI uses its configured defaultPermissionMode '
      + '(normally manual, but it may be assisted or allow-all).',
  },
  'read-only': {
    id: 'read-only',
    label: 'Restricted (explicit read/search allowlist)',
    description:
      'Only Copilot\'s explicit file-view and search tools are exposed to the model. Shell, write, web, MCP, skill, '
      + 'memory, and delegated-agent tools are unavailable.',
  },
  'trusted-directory': {
    id: 'trusted-directory',
    label: 'Trusted directory',
    description:
      'The workspace directory is trusted with --add-dir, but shell commands, file edits, URL fetches, '
      + 'and MCP tool calls still prompt for approval individually.',
  },
  'full-auto': {
    id: 'full-auto',
    label: 'Full auto (--allow-all-tools)',
    description:
      'All tool calls, including shell commands and file edits, are approved automatically. '
      + 'Use only for workspaces you fully trust.',
  },
  'full-access': {
    id: 'full-access',
    label: 'Full computer access (--allow-all)',
    description:
      'Tool, path, and URL verification are disabled. Copilot can act with the full rights of this Windows account.',
  },
}

export function isPermissionPreset(value: unknown): value is PermissionPreset {
  return typeof value === 'string' && (PERMISSION_PRESETS as readonly string[]).includes(value)
}

export function needsToolAllowlistProbe(preset: PermissionPreset): boolean {
  return preset === 'read-only'
}

/**
 * Build the `copilot` CLI launch flags for a permission preset. `workspacePath`
 * must be an absolute, already-resolved path — this function does not resolve
 * or validate it. These are the session's fixed launch baseline, independent
 * of the runtime override that Copilot restores from its event log.
 */
export function buildPermissionArgs(
  preset: PermissionPreset,
  workspacePath: string,
  capabilities: { toolAllowlist: boolean },
): string[] {
  switch (preset) {
    case 'default':
      return []
    case 'read-only':
      return capabilities.toolAllowlist
        ? ['--available-tools=view,glob,grep,ask_user']
        : ['--deny-tool=write', '--deny-tool=shell']
    case 'trusted-directory':
      return ['--add-dir', workspacePath]
    case 'full-auto':
      return ['--allow-all-tools']
    case 'full-access':
      return ['--allow-all']
    default: {
      const exhaustive: never = preset
      throw new Error(`Unknown permission preset: ${String(exhaustive)}`)
    }
  }
}

export function permissionCompatibilityWarning(
  preset: PermissionPreset,
  capabilities: { toolAllowlist: boolean },
): string | null {
  if (preset !== 'read-only' || capabilities.toolAllowlist) return null
  return 'Restricted mode is using legacy compatibility flags because this Copilot CLI does not support tool allowlists. '
    + 'Only shell and write tools are denied; web, MCP, skills, memory, and delegated-agent tools may remain available. '
    + 'Update Copilot CLI for the full read/search-only restriction.'
}
