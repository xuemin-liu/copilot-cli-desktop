/**
 * GitHub Copilot CLI has no single named permission-mode enum (unlike some other
 * agent CLIs). Instead it exposes flags: `--allow-tool`, `--deny-tool`,
 * `--allow-all-tools` (aka `/yolo`), `--allow-url`, and `--add-dir` (trust a
 * directory permanently). These presets map onto that flag surface so a
 * workspace profile can pick a coarse-grained default without hand-editing
 * flags every time a session starts.
 */
export type PermissionPreset = 'default' | 'trusted-directory' | 'full-auto'

export const PERMISSION_PRESETS: readonly PermissionPreset[] = ['default', 'trusted-directory', 'full-auto']

export interface PermissionPresetInfo {
  id: PermissionPreset
  label: string
  description: string
}

export const PERMISSION_PRESET_INFO: Readonly<Record<PermissionPreset, PermissionPresetInfo>> = {
  'default': {
    id: 'default',
    label: 'Default (prompt every time)',
    description:
      'Read-only actions run automatically. Copilot CLI prompts for approval before every mutating '
      + 'action: shell commands, file edits, URL fetches, and MCP tool calls.',
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
      'All tool calls, including shell commands and file edits, are approved automatically ("/yolo"). '
      + 'Use only for workspaces you fully trust.',
  },
}

export function isPermissionPreset(value: unknown): value is PermissionPreset {
  return typeof value === 'string' && (PERMISSION_PRESETS as readonly string[]).includes(value)
}

/**
 * Build the `copilot` CLI launch flags for a permission preset. `workspacePath`
 * must be an absolute, already-resolved path — this function does not resolve
 * or validate it.
 */
export function buildPermissionArgs(preset: PermissionPreset, workspacePath: string): string[] {
  switch (preset) {
    case 'default':
      return []
    case 'trusted-directory':
      return ['--add-dir', workspacePath]
    case 'full-auto':
      return ['--allow-all-tools']
    default: {
      const exhaustive: never = preset
      throw new Error(`Unknown permission preset: ${String(exhaustive)}`)
    }
  }
}
