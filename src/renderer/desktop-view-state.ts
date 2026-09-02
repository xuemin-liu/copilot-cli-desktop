import type { CopilotResolution } from '../main/types.js'

export type DesktopViewMode = 'loading' | 'diagnostics' | 'desktop'

export function desktopViewMode(
  loading: boolean,
  resolution: CopilotResolution | null,
  hasSessionTabs = false,
): DesktopViewMode {
  if (loading || resolution === null) return 'loading'
  return resolution.version === null && !hasSessionTabs ? 'diagnostics' : 'desktop'
}

export function canOpenSessionTab(
  resolution: CopilotResolution | null,
  tabCount: number,
  maxSessionTabs: number,
): boolean {
  return resolution !== null && resolution.version !== null && tabCount < maxSessionTabs
}
