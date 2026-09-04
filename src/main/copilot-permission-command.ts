import type { PermissionPreset } from './permission-presets.js'

/** Native runtime modes accepted by Copilot CLI's /permissions command. */
export type CopilotPermissionMode = 'default' | 'assisted' | 'allow-all'

export function permissionPresetForMode(mode: CopilotPermissionMode): PermissionPreset {
  return mode === 'allow-all' ? 'full-access' : mode
}

export function nativeModeForPermissionPreset(preset: PermissionPreset | null): CopilotPermissionMode | null {
  if (preset === 'default' || preset === 'assisted') return preset
  return preset === 'full-access' ? 'allow-all' : null
}

export function permissionConfirmationMarker(mode: CopilotPermissionMode): string {
  switch (mode) {
    case 'default': return 'All permissions have been disabled.'
    case 'assisted': return 'Auto approval is now enabled.'
    case 'allow-all': return 'All permissions are now enabled.'
  }
}

/**
 * Parses only complete commands submitted by the user. This intentionally does
 * not infer permission changes from terminal output: Copilot/model output is
 * untrusted and must never be able to elevate a restricted desktop session.
 */
export function permissionModeFromCommand(command: string): CopilotPermissionMode | null {
  const normalized = command.trim().toLowerCase().replace(/\s+/g, ' ')
  if (normalized === '/permissions default') return 'default'
  if (normalized === '/permissions assisted') return 'assisted'
  if (normalized === '/permissions allow-all' || normalized === '/allow-all' || normalized === '/yolo') {
    return 'allow-all'
  }
  return null
}

/** Tracks ordinary terminal typing until Enter so direct /permissions commands
 * can be reflected in the owning tab. Escape-based line editing is discarded
 * conservatively rather than guessing at the user's final command. */
export class CopilotPermissionCommandTracker {
  private line = ''

  accept(data: string): CopilotPermissionMode[] {
    const modes: CopilotPermissionMode[] = []
    const normalized = data.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '')
    for (let index = 0; index < normalized.length; index += 1) {
      const char = normalized[index]!
      if (char === '\r' || char === '\n') {
        const mode = permissionModeFromCommand(this.line)
        if (mode) modes.push(mode)
        this.line = ''
      } else if (char === '\x7f' || char === '\b') {
        this.line = this.line.slice(0, -1)
      } else if (char === '\x15') {
        this.line = ''
      } else if (char === '\x1b') {
        this.line = ''
      } else if (char >= ' ' && char !== '\x7f') {
        this.line = `${this.line}${char}`.slice(-512)
      }
    }
    return modes
  }
}
