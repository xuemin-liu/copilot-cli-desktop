import { redactBrowserValue } from './browser-read-privacy.js'
import type { BrowserTestPlan, BrowserTestReport, BrowserTestStep } from './browser-test-plan.js'

export interface TestObservation { passed: boolean; reason?: string; screenshot?: BrowserTestReport['screenshots'][number] }
export async function runBrowserTest(plan: BrowserTestPlan, pageId: number, executor: {
  active: () => boolean
  execute: (step: BrowserTestStep, signal: AbortSignal) => Promise<TestObservation>
  progress: (index: number, total: number, label: string) => void
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
  const report: BrowserTestReport = { description: safe(plan.description), expected: safe(plan.expected), pageId,
    status: 'passed', startedAt: new Date(started).toISOString(), durationMs: 0, steps: [], screenshots: [] }
  const check = (): void => { if (signal.aborted || !executor.active()) throw new Error(expired.signal.aborted ? 'Test timed out.' : 'Test stopped or the selected page changed.') }
  try {
    for (const [index, step] of plan.steps.entries()) {
      const stepStart = Date.now(); const label = safe(step.label)
      executor.progress(index + 1, plan.steps.length, label)
      try {
        check()
        let result = await executor.execute(step, signal)
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
        if (!result.passed) throw new Error(result.reason ?? 'Expected condition was not met before the timeout.')
        if (result.screenshot) report.screenshots.push({ ...result.screenshot, step: index + 1 })
        report.steps.push({ action: step.action, label, status: 'passed', durationMs: Date.now() - stepStart })
      } catch (error) {
        report.status = expired.signal.aborted ? 'failed' : signal.aborted || !executor.active() ? 'cancelled' : 'failed'
        report.steps.push({ action: step.action, label, status: 'failed', durationMs: Date.now() - stepStart,
          reason: safe(expired.signal.aborted ? 'Test timed out.' : error instanceof Error ? error.message : 'Step failed.') })
        for (const skipped of plan.steps.slice(index + 1)) report.steps.push({ action: skipped.action, label: safe(skipped.label), status: 'skipped', durationMs: 0 })
        break
      }
    }
  } finally { clearTimeout(timer); report.durationMs = Date.now() - started }
  return report
}
