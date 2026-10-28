import { redactBrowserValue } from './browser-read-privacy.js'
import { randomUUID } from 'node:crypto'
import type { BrowserTestPlan, BrowserTestReport, BrowserTestStep, TestDelivery } from './browser-test-plan.js'

export interface TestObservation { passed: boolean; delivery?: TestDelivery; reason?: string; detail?: string; data?: Record<string, unknown>; screenshot?: BrowserTestReport['screenshots'][number] }
export function redactTestEvidence(plan: BrowserTestPlan, value: unknown): any {
  const inputs = plan.steps.filter(step => step.action === 'fill' || step.action === 'select').map(step => step.value!).filter(Boolean).sort((a, b) => b.length - a.length)
  let inputRedacted = false
  const walk = (value: any): any => {
    if (typeof value === 'string') { for (const input of inputs) if (value.includes(input)) { inputRedacted = true; value = value.split(input).join('[redacted]') }; return value }
    if (Array.isArray(value)) return value.map(walk)
    return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, value]) => [key, walk(value)])) : value
  }
  const filtered = redactBrowserValue(value)
  return { ...walk(filtered.value), redacted: filtered.redacted || inputRedacted, truncated: filtered.truncated }
}
export async function runBrowserTest(plan: BrowserTestPlan, pageId: number, executor: {
  active: () => boolean
  execute: (step: BrowserTestStep, signal: AbortSignal) => Promise<TestObservation>
  progress: (index: number, total: number, label: string) => void
  checkpoint?: (report: BrowserTestReport, current: { id: string; action: string; delivery: TestDelivery } | null) => void
}, cancelled: AbortSignal): Promise<BrowserTestReport> {
  const started = Date.now(); const expired = new AbortController()
  const timer = setTimeout(() => expired.abort(), plan.timeoutMs ?? 120000)
  const signal = AbortSignal.any([cancelled, expired.signal])
  // Input values never appear in reports, including a value copied into a label.
  const inputs = plan.steps.filter(step => step.action === 'fill' || step.action === 'select').map(step => step.value!).filter(Boolean).sort((a, b) => b.length - a.length)
  const safe = (text: string): string => {
    for (const input of inputs) text = text.split(input).join('[redacted]')
    return String(redactBrowserValue(text).value)
  }
  const clean = (value: unknown): any => typeof value === 'string' ? safe(value) : Array.isArray(value) ? value.map(clean)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, value]) => [key, clean(value)])) : value
  const report: BrowserTestReport = { runId: randomUUID(), completed: false, description: safe(plan.description), expected: safe(plan.expected), pageId,
    status: 'passed', startedAt: new Date(started).toISOString(), durationMs: 0, steps: [], screenshots: [] }
  const check = (): void => { if (signal.aborted || !executor.active()) throw new Error(expired.signal.aborted ? 'Test timed out.' : 'Test stopped or the selected page changed.') }
  try {
    for (const [index, step] of plan.steps.entries()) {
      const stepStart = Date.now(); const label = safe(step.label)
      const id = `${report.runId}:${index + 1}`
      executor.progress(index + 1, plan.steps.length, label)
      executor.checkpoint?.(report, { id, action: step.action, delivery: 'not-attempted' })
      let result: TestObservation | undefined
      try {
        check()
        result = await executor.execute(step, signal)
        const end = stepStart + (step.timeoutMs ?? (step.action === 'waitFor' ? 30000 : 5000))
        while (!result.passed && ['waitFor', 'assert'].includes(step.action) && Date.now() < end) {
          check()
          await new Promise<void>((resolve, reject) => {
            const abort = (): void => { clearTimeout(wait); reject(new Error('Test stopped.')) }
            const wait = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, Math.min(150, Math.max(1, end - Date.now())))
            signal.addEventListener('abort', abort, { once: true })
            if (signal.aborted) abort()
          })
          check()
          if (Date.now() >= end) break
          result = await executor.execute(step, signal)
        }
        check()
        if (!result.passed) throw Object.assign(new Error(result.reason ?? 'Expected condition was not met before the timeout.'), { delivery: result.delivery, data: result.data })
        if (result.screenshot) report.screenshots.push({ ...result.screenshot, step: index + 1 })
        const observation = ['discover', 'screenshot', 'waitFor'].includes(step.action)
        report.steps.push({ id, action: step.action, label, status: 'passed', outcome: step.action === 'assert' ? 'assertion-passed' : observation ? 'observed' : 'delivered',
          delivery: result.delivery ?? 'not-attempted', durationMs: Date.now() - stepStart,
          ...(result.detail ? { detail: safe(result.detail) } : {}), ...(result.data ? { data: clean(result.data) } : {}) })
        executor.checkpoint?.(report, null)
      } catch (error) {
        report.status = expired.signal.aborted ? 'failed' : signal.aborted || !executor.active() ? 'cancelled' : 'failed'
        const failure = { delivery: result?.delivery, data: result?.data, ...error as { delivery?: TestDelivery; data?: Record<string, unknown> } }
        report.steps.push({ id, action: step.action, label, status: 'failed',
          outcome: failure.delivery === 'uncertain' ? 'uncertain' : report.status === 'cancelled' ? 'cancelled' : step.action === 'assert' ? 'assertion-failed' : 'failed',
          delivery: failure.delivery ?? 'not-attempted', ...(failure.data ? { data: clean(failure.data) } : {}), durationMs: Date.now() - stepStart,
          reason: safe(expired.signal.aborted ? 'Test timed out.' : error instanceof Error ? error.message : 'Step failed.') })
        for (const [offset, skipped] of plan.steps.slice(index + 1).entries()) report.steps.push({ id: `${report.runId}:${index + offset + 2}`, action: skipped.action, label: safe(skipped.label), status: 'skipped', outcome: 'skipped', delivery: 'not-attempted', durationMs: 0 })
        executor.checkpoint?.(report, null)
        break
      }
    }
  } finally { clearTimeout(timer); report.durationMs = Date.now() - started; report.completed = true }
  return report
}
