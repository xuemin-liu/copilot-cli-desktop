export type SessionPermissionMode = 'manual' | 'assisted' | 'allow-all'

export const SESSION_PERMISSION_MODE_INFO: Readonly<Record<SessionPermissionMode, { label: string }>> = {
  manual: { label: 'Manual approval' },
  assisted: { label: 'Assisted approval' },
  'allow-all': { label: 'Allow all' },
}

export function isSessionPermissionMode(value: unknown): value is SessionPermissionMode {
  return value === 'manual' || value === 'assisted' || value === 'allow-all'
}

export function parsePermissionChangedEvent(line: string): SessionPermissionMode | null {
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return null
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null
  const record = event as { type?: unknown; data?: { mode?: unknown } }
  if (record.type !== 'session.permissions_changed') return null
  return isSessionPermissionMode(record.data?.mode) ? record.data.mode : null
}
