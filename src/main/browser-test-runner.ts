import { redactBrowserValue } from './browser-read-privacy.js'
import { randomUUID } from 'node:crypto'
import type { BrowserTestPlan, BrowserTestReport, BrowserTestStep, TestDelivery, TestStepConsole } from './browser-test-plan.js'
import type { ConsoleErrorRecord } from './browser-test-console.js'

export interface TestObservation { passed: boolean; delivery?: TestDelivery; reason?: string; detail?: string; data?: Record<string, unknown>; screenshot?: BrowserTestReport['screenshots'][number]
  /** Evidence images kept whether the step passes or fails, such as a comparison's capture and diff. */
  screenshots?: BrowserTestReport['screenshots'] }
/** The plan's fill and select values, longest first. */
/** Steps whose outcome is an assertion: assert, compareScreenshot, and measure or metrics steps with a limit. */
export function assertionStep(step: BrowserTestStep): boolean {
  return step.action === 'assert' || step.action === 'compareScreenshot'
    || step.action === 'frameSequence' || step.action === 'assertMeasurement'
    || step.action === 'networkSummary' && [step.minRequests, step.maxRequests, step.maxBytes, step.minCacheHits, step.maxFailures].some(value => value !== undefined)
    || step.action === 'sampleMetrics' && Boolean(step.samples?.some(sample => sample.max !== undefined || sample.maxGrowth !== undefined))
    || step.action === 'measure' && (step.maxMs !== undefined || step.minPerSecond !== undefined || step.maxPerSecond !== undefined)
    || step.action === 'metrics' && (step.maxHeapGrowthMb !== undefined || step.maxNodeGrowth !== undefined)
}
export function testInputs(plan: BrowserTestPlan): string[] {
  return plan.steps.filter(step => step.action === 'fill' || step.action === 'select').map(step => step.value!).filter(Boolean).sort((a, b) => b.length - a.length)
}
/** Replaces every supplied input value in text, and the start of one (4 characters or more) left at
 * the end by an earlier cut, such as the capture limit. Run it before any further cutting. */
export function redactInputs(text: string, inputs: string[]): string {
  for (const input of inputs) if (text.includes(input)) text = text.split(input).join('[redacted]')
  for (const input of inputs) {
    const length = prefixAtEnd(input, text)
    if (length >= Math.min(4, input.length)) text = `${text.slice(0, text.length - length)}[redacted]`
  }
  return text
}
/** The longest proper prefix of `input` that `text` ends with, in linear time: the page controls the
 * text, so a quadratic search could stall the main process. One prefix-function (KMP) pass over
 * input, a separator plan values never contain, and the end of the text. */
function prefixAtEnd(input: string, text: string): number {
  if (input.length < 2 || !text) return 0
  const s = `${input}\u0000${text.slice(-(input.length - 1))}`
  const pi = new Int32Array(s.length)
  for (let i = 1; i < s.length; i++) {
    let k = pi[i - 1]!
    while (k > 0 && s[i] !== s[k]) k = pi[k - 1]!
    if (s[i] === s[k]) k++
    pi[i] = k
  }
  return pi[s.length - 1]!
}
export function redactTestEvidence(plan: BrowserTestPlan, value: unknown): any {
  const inputs = testInputs(plan)
  let inputRedacted = false
  // Inputs first: the credential filter below may cut text, and a cut value is no longer recognizable.
  const walk = (value: any): any => {
    if (typeof value === 'string') { const clean = redactInputs(value, inputs); if (clean !== value) inputRedacted = true; return clean }
    if (Array.isArray(value)) return value.map(walk)
    return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, value]) => [key, walk(value)])) : value
  }
  const filtered = redactBrowserValue(walk(value))
  return { ...filtered.value as Record<string, unknown>, redacted: filtered.redacted || inputRedacted, truncated: filtered.truncated }
}
export async function runBrowserTest(plan: BrowserTestPlan, pageId: number, executor: {
  active: () => boolean
  execute: (step: BrowserTestStep, signal: AbortSignal) => Promise<TestObservation>
  progress: (index: number, total: number, label: string) => void
  checkpoint?: (report: BrowserTestReport, current: { id: string; action: string; delivery: TestDelivery } | null) => void
  /** The test page's console: sequence marks, per-step slices, and errors latched by failOnConsoleError. */
  console?: { mark: () => number; slice: (after: number) => TestStepConsole; takeErrors: () => { errors: ConsoleErrorRecord[]; more: number } }
}, cancelled: AbortSignal): Promise<BrowserTestReport> {
  const started = Date.now(); const expired = new AbortController()
  const timer = setTimeout(() => expired.abort(), plan.timeoutMs ?? 120000)
  const signal = AbortSignal.any([cancelled, expired.signal])
  // Input values never appear in reports, including a value copied into a label.
  const inputs = testInputs(plan)
  const safe = (text: string): string => String(redactBrowserValue(redactInputs(text, inputs)).value)
  const clean = (value: unknown): any => typeof value === 'string' ? safe(value) : Array.isArray(value) ? value.map(clean)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, value]) => [key, clean(value)])) : value
  const report: BrowserTestReport = { runId: randomUUID(), completed: false, description: safe(plan.description), expected: safe(plan.expected), pageId,
    status: 'passed', startedAt: new Date(started).toISOString(), durationMs: 0, steps: [], screenshots: [] }
  const check = (): void => { if (signal.aborted || !executor.active()) throw new Error(expired.signal.aborted ? 'Test timed out.' : 'Test stopped or the selected page changed.') }
  // A console error fails the step it arrived in at a safe boundary: a wait stops at its next
  // poll, and an action finishes delivering first. It is never retried.
  let latched: { errors: ConsoleErrorRecord[]; more: number } | null = null
  const latch = (): boolean => {
    const taken = executor.console?.takeErrors()
    if (taken?.errors.length) latched = latched ? { errors: [...latched.errors, ...taken.errors].slice(0, 20), more: latched.more + taken.more } : taken
    return latched !== null
  }
  // Measurements and metrics readings are also gathered in one list, pass or fail.
  const measured = (result: TestObservation | undefined): void => {
    const value = result?.data?.measurement ?? result?.data?.metrics ?? result?.data?.frameSequence ?? result?.data?.networkSummary ?? result?.data?.sampleMetrics
    if (value) (report.measurements ??= []).push(clean({ step: report.steps.length + 1, ...(result!.data!.metrics ? { kind: 'metrics' } : {}), ...value as Record<string, unknown> }))
  }
  const stepConsole = (after: number | undefined): { console?: TestStepConsole } => {
    if (after === undefined || !executor.console) return {}
    const slice = executor.console.slice(after)
    return slice.total || !slice.complete ? { console: clean(slice) } : {}
  }
  try {
    for (const [index, step] of plan.steps.entries()) {
      const stepStart = Date.now(); const label = safe(step.label)
      const id = `${report.runId}:${index + 1}`
      executor.progress(index + 1, plan.steps.length, label)
      executor.checkpoint?.(report, { id, action: step.action, delivery: 'not-attempted' })
      let result: TestObservation | undefined
      let imagesKept = false
      const consoleStart = executor.console?.mark()
      latched = null
      try {
        check()
        result = await executor.execute(step, signal)
        const end = stepStart + (step.timeoutMs ?? (step.action === 'waitFor' ? 30000 : 5000))
        while (!result.passed && ['waitFor', 'assert'].includes(step.action) && Date.now() < end && !latch()) {
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
        if (latch() && latched) {
          const { errors, more } = latched as { errors: ConsoleErrorRecord[]; more: number }
          throw Object.assign(new Error(`Console error during this step: ${errors[0]!.message}${errors.length + more > 1 ? ` (and ${errors.length + more - 1} more)` : ''}`),
            { delivery: result.delivery, data: { ...result.data, consoleErrors: { errors, more } } })
        }
        if (!result.passed) throw Object.assign(new Error(result.reason ?? 'Expected condition was not met before the timeout.'), { delivery: result.delivery, data: result.data })
        if (result.screenshot) report.screenshots.push({ ...result.screenshot, step: index + 1 })
        for (const image of result.screenshots ?? []) report.screenshots.push({ ...image, step: index + 1 })
        imagesKept = true
        measured(result)
        const observation = ['discover', 'capture', 'screenshot', 'waitFor', 'measure', 'metrics', 'networkSummary', 'sampleMetrics'].includes(step.action)
        const assertion = assertionStep(step)
        report.steps.push({ id, action: step.action, label, status: 'passed', outcome: assertion ? 'assertion-passed' : observation ? 'observed' : 'delivered',
          delivery: result.delivery ?? 'not-attempted', durationMs: Date.now() - stepStart,
          ...(result.detail ? { detail: safe(result.detail) } : {}), ...(result.data ? { data: clean(result.data) } : {}), ...stepConsole(consoleStart) })
        executor.checkpoint?.(report, null)
      } catch (error) {
        report.status = expired.signal.aborted ? 'failed' : signal.aborted || !executor.active() ? 'cancelled' : 'failed'
        // A failed comparison keeps its capture and diff: they are the evidence of what differed.
        if (!imagesKept) { for (const image of result?.screenshots ?? []) report.screenshots.push({ ...image, step: index + 1 }); measured(result) }
        const failure = { delivery: result?.delivery, data: result?.data, ...error as { delivery?: TestDelivery; data?: Record<string, unknown> } }
        report.steps.push({ id, action: step.action, label, status: 'failed',
          outcome: failure.delivery === 'uncertain' ? 'uncertain' : report.status === 'cancelled' ? 'cancelled' : assertionStep(step) ? 'assertion-failed' : 'failed',
          delivery: failure.delivery ?? 'not-attempted', ...(failure.data ? { data: clean(failure.data) } : {}), durationMs: Date.now() - stepStart,
          reason: safe(expired.signal.aborted ? 'Test timed out.' : error instanceof Error ? error.message : 'Step failed.'), ...stepConsole(consoleStart) })
        for (const [offset, skipped] of plan.steps.slice(index + 1).entries()) report.steps.push({ id: `${report.runId}:${index + offset + 2}`, action: skipped.action, label: safe(skipped.label), status: 'skipped', outcome: 'skipped', delivery: 'not-attempted', durationMs: 0 })
        executor.checkpoint?.(report, null)
        break
      }
    }
  } finally { clearTimeout(timer); report.durationMs = Date.now() - started; report.completed = true }
  return report
}
