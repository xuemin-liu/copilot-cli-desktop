import { parseSafeHttpUrl } from './external-targets.js'

export const MAX_TEST_BYTES = 128 * 1024
export const TEST_KEYS = ['Enter', 'Tab', 'Escape', 'Space', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'] as const
export interface TestRequestMatch { urlPattern: string; method: string }
export interface TestNetworkFailure extends TestRequestMatch {
  failure: 'transport' | 'http'; status?: number; maxRequests: number; durationMs: number
}
export interface BrowserTestCondition {
  selector?: string
  targetRef?: string
  text?: string
  frame?: string
  condition?: 'visible' | 'hidden' | 'enabled' | 'text' | 'count' | 'checked' | 'value' | 'numericValue' | 'attribute' | 'imageLoaded' | 'canvasPainted' | 'url' | 'requestComplete'
  attribute?: string
  expected?: string | number | boolean
  tolerance?: number
  request?: TestRequestMatch & { state: 'finished' | 'failed'; status?: number }
}
export interface BrowserTestStep extends BrowserTestCondition {
  action: 'navigate' | 'reload' | 'discover' | 'click' | 'doubleClick' | 'hover' | 'drag' | 'fill' | 'select' | 'press' | 'scroll' | 'waitFor' | 'assert' | 'screenshot'
  label: string
  inputSelector?: string
  inputRef?: string
  point?: { x: number; y: number }
  modifiers?: ('Alt' | 'Control' | 'Meta' | 'Shift')[]
  button?: 'left' | 'middle' | 'right'
  url?: string
  value?: string
  key?: string
  pixels?: number
  path?: { x: number; y: number }[]
  durationMs?: number
  timeoutMs?: number
  /** All conditions must hold in the same polling pass. No user code is evaluated. */
  all?: BrowserTestCondition[]
  dialog?: { accept: boolean; message?: string }
}
export interface BrowserTestPlan {
  description: string; expected: string; steps: BrowserTestStep[]; timeoutMs?: number
  allowNetworkFailures?: boolean; networkFailures?: TestNetworkFailure[]
}
export type TestDelivery = 'not-attempted' | 'partial' | 'delivered' | 'uncertain'
export interface BrowserTestStepResult {
  id?: string; action: string; label: string; status: 'passed' | 'failed' | 'skipped'; durationMs: number
  outcome?: 'delivered' | 'assertion-passed' | 'assertion-failed' | 'observed' | 'skipped' | 'cancelled' | 'uncertain' | 'failed'
  delivery?: TestDelivery; reason?: string; detail?: string; data?: Record<string, unknown>
}
export interface BrowserTestReport {
  runId?: string; completed?: boolean; origin?: string; testingEnabled?: boolean
  description: string; expected: string; pageId: number; status: 'passed' | 'failed' | 'cancelled'; startedAt: string; durationMs: number
  steps: BrowserTestStepResult[]
  screenshots: { step: number; imageBase64?: string; redacted: boolean; path?: string }[]
  evidence?: Record<string, unknown>
}
export interface BrowserTestState {
  enabled: boolean; running: boolean; step: number; total: number; label: string; report: Omit<BrowserTestReport, 'screenshots'> | null
  runId?: string
  currentAction?: { id: string; action: string; delivery: TestDelivery } | null
  lastCompletedAction?: BrowserTestStepResult | null
  /** Live journal is separate so progress cannot resize the UI's last-test panel. */
  journal?: Omit<BrowserTestReport, 'screenshots'>
}

/** Literal URL glob, not a regular expression. Only * has special meaning. */
export function testRequestMatches(rule: TestRequestMatch, url: string, method: string): boolean {
  if (rule.method !== method) return false
  const parts = rule.urlPattern.split('*')
  if (parts.length === 1) return url === rule.urlPattern
  const first = parts.shift()!, last = parts.pop()!
  if (!url.startsWith(first) || !url.endsWith(last)) return false
  let offset = first.length
  const end = url.length - last.length
  for (const part of parts) { const next = url.indexOf(part, offset); if (next < 0 || next + part.length > end) return false; offset = next + part.length }
  return offset <= end
}

/** Closed shapes and bounded fixed actions, never arbitrary scripts, headers, bodies or replay. */
export function validateBrowserTestPlan(value: unknown): BrowserTestPlan {
  const fail = (message: string): never => { throw new Error(`Invalid browser test: ${message}`) }
  const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail('expected an object.')
    return v as Record<string, unknown>
  }
  const fields = (v: Record<string, unknown>, allowed: string[]): void => {
    if (Object.keys(v).some(key => !allowed.includes(key))) fail('unsupported field.')
  }
  const string = (v: unknown, max: number, empty = false): void => {
    if (typeof v !== 'string' || (!empty && !v.trim()) || v.length > max || v.includes('\0')) fail('missing or oversized text.')
  }
  const timeout = (v: unknown, max: number): void => {
    if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v < 100 || v > max)) fail('timeout is out of range.')
  }
  const target = (v: Record<string, unknown>, required: boolean): void => {
    if (v.selector !== undefined) string(v.selector, 512)
    if (v.targetRef !== undefined && (typeof v.targetRef !== 'string' || !/^[a-f0-9]{32}-t\d{1,3}$/.test(v.targetRef))) fail('invalid target reference.')
    if (v.selector !== undefined && v.targetRef !== undefined || required && v.selector === undefined && v.targetRef === undefined) fail('use exactly one selector or targetRef.')
    if (v.frame !== undefined && (typeof v.frame !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(v.frame))) fail('invalid frame ID.')
    if (v.text !== undefined) string(v.text, 2000)
  }
  const requestMatch = (v: Record<string, unknown>): void => {
    string(v.urlPattern, 2048)
    const url = new URL(parseSafeHttpUrl(String(v.urlPattern).replaceAll('*', 'wildcard')))
    if (url.search || url.hash || String(v.urlPattern).split('://')[1]?.split('/')[0]?.includes('*')) fail('request patterns need a literal origin and no query or fragment.')
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(String(v.method))) fail('unsupported request method.')
  }
  const conditionFields = ['selector', 'targetRef', 'text', 'frame', 'condition', 'attribute', 'expected', 'tolerance', 'request']
  const condition = (v: Record<string, unknown>): void => {
    if (!['visible', 'hidden', 'enabled', 'text', 'count', 'checked', 'value', 'numericValue', 'attribute', 'imageLoaded', 'canvasPainted', 'url', 'requestComplete'].includes(String(v.condition))) fail('unsupported condition.')
    target(v, !['url', 'requestComplete'].includes(String(v.condition)))
    if (['url', 'requestComplete'].includes(String(v.condition)) && [v.selector, v.targetRef, v.text, v.frame].some(x => x !== undefined)) fail('this condition takes no target.')
    if (v.condition === 'requestComplete') {
      const request = object(v.request); fields(request, ['urlPattern', 'method', 'state', 'status']); requestMatch(request)
      if (!['finished', 'failed'].includes(String(request.state))) fail('request state must be finished or failed.')
      if (request.status !== undefined && (typeof request.status !== 'number' || !Number.isInteger(request.status) || request.status < 100 || request.status > 599)) fail('invalid request status.')
    } else if (v.request !== undefined) fail('request requires requestComplete.')
    if (v.condition === 'attribute') {
      if (typeof v.attribute !== 'string' || !/^(data-test-[a-z0-9-]{1,64}|aria-[a-z-]{1,64}|role|title|class)$/.test(v.attribute)) fail('use a public data-test-*, aria-*, role, title or class attribute.')
    } else if (v.attribute !== undefined) fail('attribute requires the attribute condition.')
    if (v.tolerance !== undefined && (v.condition !== 'numericValue' || typeof v.tolerance !== 'number' || !Number.isFinite(v.tolerance) || v.tolerance < 0 || v.tolerance > 1e12)) fail('invalid numeric tolerance.')
    if (['text', 'url', 'value', 'attribute'].includes(String(v.condition))) string(v.expected, 2000, ['value', 'attribute'].includes(String(v.condition)))
    else if (v.condition === 'numericValue') {
      if (typeof v.expected !== 'number' || !Number.isFinite(v.expected) || Math.abs(v.expected) > 1e12) fail('invalid expected number.')
    } else if (v.condition === 'count') {
      if (typeof v.expected !== 'number' || !Number.isInteger(v.expected) || v.expected < 0 || v.expected > 10000) fail('invalid expected count.')
    } else if (v.condition === 'checked') { if (typeof v.expected !== 'boolean') fail('expected must be boolean.') }
    else if (v.expected !== undefined) fail('this condition takes no expected value.')
  }
  const plan = object(structuredClone(value))
  fields(plan, ['description', 'expected', 'steps', 'timeoutMs', 'allowNetworkFailures', 'networkFailures'])
  string(plan.description, 4000); string(plan.expected, 4000); timeout(plan.timeoutMs, 300000)
  if (plan.allowNetworkFailures !== undefined && typeof plan.allowNetworkFailures !== 'boolean') fail('allowNetworkFailures must be boolean.')
  if (plan.networkFailures !== undefined) {
    if (plan.allowNetworkFailures !== true) fail('network failure simulation requires explicit allowNetworkFailures: true.')
    if (!Array.isArray(plan.networkFailures) || plan.networkFailures.length < 1 || plan.networkFailures.length > 8) fail('use 1–8 failure rules.')
    for (const raw of plan.networkFailures as unknown[]) {
      const rule = object(raw); fields(rule, ['urlPattern', 'method', 'failure', 'status', 'maxRequests', 'durationMs']); requestMatch(rule)
      if (!['transport', 'http'].includes(String(rule.failure))) fail('unsupported network failure.')
      if (rule.failure === 'http' ? typeof rule.status !== 'number' || !Number.isInteger(rule.status) || rule.status < 400 || rule.status > 599 : rule.status !== undefined) fail('HTTP failures require status 400–599; transport failures take no status.')
      if (typeof rule.maxRequests !== 'number' || !Number.isInteger(rule.maxRequests) || rule.maxRequests < 1 || rule.maxRequests > 20) fail('failure rules require maxRequests within 1–20.')
      if (rule.durationMs === undefined) fail('failure rules require durationMs.')
      timeout(rule.durationMs, 60000)
    }
  }
  if (!Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 50) fail('use 1–50 steps.')
  let assertions = 0; let screenshots = 0
  for (const [index, raw] of (plan.steps as unknown[]).entries()) {
    const step = object(raw)
    const pointer = ['selector', 'targetRef', 'inputSelector', 'inputRef', 'point', 'text', 'frame', 'modifiers']
    const extra: Record<string, string[]> = {
      navigate: ['url', 'dialog'], reload: ['all', 'timeoutMs', 'dialog'], discover: ['frame'],
      click: [...pointer, 'button', 'dialog'], doubleClick: [...pointer, 'button', 'dialog'], hover: pointer,
      drag: [...pointer.filter(field => field !== 'point'), 'button', 'path', 'durationMs'],
      fill: ['selector', 'targetRef', 'text', 'frame', 'value', 'dialog'], select: ['selector', 'targetRef', 'text', 'frame', 'value', 'dialog'],
      press: ['selector', 'targetRef', 'text', 'frame', 'key', 'modifiers', 'dialog'], scroll: ['selector', 'targetRef', 'text', 'frame', 'pixels'],
      waitFor: [...conditionFields, 'all', 'timeoutMs'], assert: [...conditionFields, 'all', 'timeoutMs'], screenshot: [],
    }
    if (typeof step.action !== 'string' || !extra[step.action]) fail('unsupported action.')
    fields(step, ['action', 'label', ...extra[String(step.action)]!])
    if (step.label === undefined) step.label = `${step.action} step ${index + 1}`
    string(step.label, 200)
    target(step, ['click', 'doubleClick', 'hover', 'drag', 'fill', 'select', 'press'].includes(String(step.action)))
    if (step.inputSelector !== undefined) string(step.inputSelector, 512)
    if (step.inputRef !== undefined) target({ targetRef: step.inputRef }, true)
    if (step.inputSelector !== undefined && step.inputRef !== undefined) fail('use one inputSelector or inputRef.')
    const point = (raw: unknown): void => {
      const p = object(raw); fields(p, ['x', 'y'])
      if (![p.x, p.y].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 20000)) fail('coordinates must be finite CSS pixels within 0–19999.')
    }
    if (step.point !== undefined) point(step.point)
    if (step.action !== 'drag' && (step.inputSelector !== undefined || step.inputRef !== undefined) && step.point === undefined) fail('pointer input surface requires a point.')
    if (step.modifiers !== undefined && (!Array.isArray(step.modifiers) || step.modifiers.length > 4 || new Set(step.modifiers).size !== step.modifiers.length || step.modifiers.some(m => !['Alt', 'Control', 'Meta', 'Shift'].includes(String(m))))) fail('invalid modifiers.')
    if (step.button !== undefined && !['left', 'middle', 'right'].includes(String(step.button))) fail('unsupported pointer button.')
    if (step.dialog !== undefined) {
      const dialog = object(step.dialog); fields(dialog, ['accept', 'message'])
      if (typeof dialog.accept !== 'boolean') fail('dialog.accept must be true or false.')
      if (dialog.message !== undefined) string(dialog.message, 500)
    }
    if (step.action === 'navigate') { string(step.url, 8192); parseSafeHttpUrl(step.url as string) }
    if (step.action === 'drag') {
      if (!Array.isArray(step.path) || step.path.length < 2 || step.path.length > 100) fail('drag requires 2–100 path points.')
      for (const rawPoint of step.path as unknown[]) point(rawPoint)
      if (step.durationMs !== undefined && (typeof step.durationMs !== 'number' || !Number.isInteger(step.durationMs) || step.durationMs < 100 || step.durationMs > 5000)) fail('drag duration must be within 100–5000 milliseconds.')
    }
    if (step.action === 'fill' || step.action === 'select') string(step.value, 8192, true)
    if (step.action === 'press' && !TEST_KEYS.includes(step.key as typeof TEST_KEYS[number])) fail('unsupported key.')
    if (step.action === 'scroll' && (typeof step.pixels !== 'number' || !Number.isInteger(step.pixels) || Math.abs(step.pixels) > 2000)) fail('scroll must be within 2000 pixels.')
    if (step.action === 'screenshot' && ++screenshots > 5) fail('use at most five screenshots.')
    if (['waitFor', 'assert', 'reload'].includes(String(step.action))) {
      timeout(step.timeoutMs, 60000)
      if (step.all !== undefined) {
        if (conditionFields.some(key => step[key] !== undefined)) fail('all cannot be combined with a single condition.')
        if (!Array.isArray(step.all) || step.all.length < 1 || step.all.length > 10) fail('use 1–10 readiness conditions.')
        for (const rawCondition of step.all as unknown[]) { const c = object(rawCondition); fields(c, conditionFields); condition(c) }
      } else if (step.action !== 'reload') condition(step)
      if (step.action === 'assert') assertions++
    }
  }
  if (!assertions) fail('include at least one assertion of the expected result.')
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_TEST_BYTES) fail('plan exceeds 128 KiB.')
  return plan as unknown as BrowserTestPlan
}
