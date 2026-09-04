import { PERMISSION_PRESET_INFO, type PermissionPreset } from './permission-presets.js'

export type SessionPermissionMode = 'manual' | 'assisted' | 'allow-all'
export type SessionPermissionTone = PermissionPreset | 'manual' | 'assisted'

export const SESSION_PERMISSION_MODE_INFO: Readonly<Record<SessionPermissionMode, { label: string }>> = {
  manual: { label: 'Manual approval' },
  assisted: { label: 'Assisted approval' },
  'allow-all': { label: 'Allow all' },
}

export function isSessionPermissionMode(value: unknown): value is SessionPermissionMode {
  return value === 'manual' || value === 'assisted' || value === 'allow-all'
}

export function describeSessionPermission(
  preset: PermissionPreset,
  mode: SessionPermissionMode | null,
): { label: string; tone: SessionPermissionTone } {
  const tone = preset === 'read-only' || preset === 'trusted-directory'
    ? preset
    : mode === 'allow-all'
      ? 'full-access'
      : mode ?? preset
  if (!mode) return { label: PERMISSION_PRESET_INFO[preset].label, tone }
  if (preset === 'full-access') return {
    label: 'Full computer access · Startup flags remain enabled', tone: 'full-access',
  }
  if (preset === 'full-auto' && mode !== 'allow-all') return {
    label: `Tools auto-approved · ${mode === 'manual' ? 'Manual' : 'Assisted'} path/URL approval`, tone: 'full-auto',
  }
  const modeLabel = SESSION_PERMISSION_MODE_INFO[mode].label
  if (preset === 'read-only') return { label: `Restricted tools · ${modeLabel}`, tone }
  if (preset === 'trusted-directory') return { label: `Trusted directory · ${modeLabel}`, tone }
  return { label: modeLabel, tone }
}

export function parsePermissionChangedEvent(
  line: string,
  onUnknownPayload?: (payload: unknown) => void,
): SessionPermissionMode | null {
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return null
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null
  const record = event as { type?: unknown; data?: unknown }
  if (record.type !== 'session.permissions_changed') return null
  if (!record.data || typeof record.data !== 'object' || Array.isArray(record.data)) {
    onUnknownPayload?.(record.data)
    return null
  }
  const data = record.data as {
    mode?: unknown
    allowAllPermissionMode?: unknown
    allowAllPermissions?: unknown
  }
  if (isSessionPermissionMode(data.mode)) return data.mode
  if (data.allowAllPermissionMode === 'off') return 'manual'
  if (data.allowAllPermissionMode === 'auto') return 'assisted'
  if (data.allowAllPermissionMode === 'on') return 'allow-all'
  if (data.allowAllPermissions === true) return 'allow-all'
  if (data.allowAllPermissions === false) return 'manual'
  onUnknownPayload?.(record.data)
  return null
}
