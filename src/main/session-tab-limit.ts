/** How many session tabs may be open at once; kept apart from main.ts so the Settings window can use it. */
export const DEFAULT_MAX_SESSION_TABS = 20
export const MAX_MAX_SESSION_TABS = 50
/** Hidden reviewer slots shared by temporary PR reviews and review meetings. */
export const MAX_TEMP_REVIEWER_TABS = 8

export function isMaxSessionTabs(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_MAX_SESSION_TABS
}

export function normalizeMaxSessionTabs(value: unknown): number {
  return isMaxSessionTabs(value) ? value : DEFAULT_MAX_SESSION_TABS
}
