/** Chrome's page zoom steps. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const

/** The next step in the given direction, or 1 to reset. Starts from the nearest step when the factor is between two. */
export function nextZoomFactor(current: number, direction: 'in' | 'out' | 'reset'): number {
  if (direction === 'reset' || !Number.isFinite(current) || current <= 0) return 1
  let nearest = 0
  for (let index = 1; index < ZOOM_STEPS.length; index++) {
    if (Math.abs(ZOOM_STEPS[index]! - current) < Math.abs(ZOOM_STEPS[nearest]! - current)) nearest = index
  }
  const next = direction === 'in'
    ? (ZOOM_STEPS[nearest]! > current + 1e-6 ? nearest : nearest + 1)
    : (ZOOM_STEPS[nearest]! < current - 1e-6 ? nearest : nearest - 1)
  return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, next))]!
}
