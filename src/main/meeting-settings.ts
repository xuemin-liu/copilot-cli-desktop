/** Limits for review meetings between sessions; kept apart from meeting.ts so the Settings window can use them. */
export const DEFAULT_MEETING_MAX_ROUNDS = 6
export const MAX_MEETING_MAX_ROUNDS = 30
export const DEFAULT_MEETING_ROUND_TIMEOUT_MINUTES = 10
export const MAX_MEETING_ROUND_TIMEOUT_MINUTES = 120

export function isMeetingMaxRounds(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_MEETING_MAX_ROUNDS
}

export function normalizeMeetingMaxRounds(value: unknown): number {
  return isMeetingMaxRounds(value) ? value : DEFAULT_MEETING_MAX_ROUNDS
}

export function isMeetingRoundTimeoutMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_MEETING_ROUND_TIMEOUT_MINUTES
}

export function normalizeMeetingRoundTimeoutMinutes(value: unknown): number {
  return isMeetingRoundTimeoutMinutes(value) ? value : DEFAULT_MEETING_ROUND_TIMEOUT_MINUTES
}
