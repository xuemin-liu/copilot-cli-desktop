import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PERMISSION_PRESET_INFO, type PermissionPreset } from './permission-presets.js'

const execFileAsync = promisify(execFile)

export type ElevationStatus = 'standard-user' | 'administrator' | 'unknown'

export interface AccessStatus {
  permissionPreset: PermissionPreset
  permissionLabel: string
  permissionSource: 'environment' | 'profile'
  elevation: ElevationStatus
  warning: string | null
}

export function parseWindowsElevation(groups: string): ElevationStatus {
  if (/S-1-16-(12288|16384)\b/i.test(groups)) return 'administrator'
  if (/S-1-16-(4096|8192)\b/i.test(groups)) return 'standard-user'
  return 'unknown'
}

async function detectElevation(): Promise<ElevationStatus> {
  if (process.platform !== 'win32') {
    return typeof process.getuid === 'function' && process.getuid() === 0 ? 'administrator' : 'standard-user'
  }
  try {
    const { stdout } = await execFileAsync('whoami.exe', ['/groups', '/fo', 'csv', '/nh'], {
      windowsHide: true,
      timeout: 3_000,
    })
    return parseWindowsElevation(stdout)
  } catch {
    return 'unknown'
  }
}

let elevationPromise: Promise<ElevationStatus> | null = null

function cachedElevation(): Promise<ElevationStatus> {
  elevationPromise ??= detectElevation()
  return elevationPromise
}

export async function readAccessStatus(profilePreset: PermissionPreset): Promise<AccessStatus> {
  const environmentAllowsAll = /^(1|true|yes)$/i.test(process.env.COPILOT_ALLOW_ALL ?? '')
  const permissionPreset: PermissionPreset = environmentAllowsAll ? 'full-access' : profilePreset
  const permissionSource: AccessStatus['permissionSource'] = environmentAllowsAll ? 'environment' : 'profile'
  const elevation = await cachedElevation()
  const warnings: string[] = []
  if (permissionPreset === 'full-auto') {
    warnings.push('Copilot tools run without individual approval, but path and URL verification still apply.')
  } else if (permissionPreset === 'full-access') {
    warnings.push('Copilot can use tools, paths, and URLs without approval.')
  }
  if (elevation === 'administrator') {
    warnings.push('The desktop process is elevated, so Copilot sessions inherit administrator rights.')
  }
  return {
    permissionPreset,
    permissionLabel: PERMISSION_PRESET_INFO[permissionPreset].label,
    permissionSource,
    elevation,
    warning: warnings.length > 0 ? warnings.join(' ') : null,
  }
}
